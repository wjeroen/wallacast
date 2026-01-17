import { query } from '../database/db.js';

/**
 * Wallabag API Service
 *
 * Handles OAuth authentication and API communication with Wallabag instances.
 * Each service instance is tied to a specific user.
 */

// ============================================================================
// Type Definitions
// ============================================================================

export interface WallabagEntry {
  id: number;
  url: string;
  title: string;
  content: string;
  is_archived: number;  // 0 or 1
  is_starred: number;   // 0 or 1
  tags: Array<{ id: number; label: string; slug: string }>;
  preview_picture: string | null;
  domain_name: string;
  reading_time: number;
  created_at: string;   // ISO datetime
  updated_at: string;   // ISO datetime
  published_at: string | null;
  published_by: string[] | null;
}

export interface CreateEntryData {
  url: string;
  title?: string;
  content?: string;
  tags?: string;        // Comma-separated
  archive?: boolean;
  starred?: boolean;
  published_at?: string;
}

export interface UpdateEntryData {
  title?: string;
  content?: string;
  tags?: string;
  archive?: boolean;
  starred?: boolean;
}

interface TokenResponse {
  access_token: string;
  expires_in: number;   // Seconds until expiry
  refresh_token: string;
  token_type: string;   // "bearer"
}

// ============================================================================
// WallabagService Class
// ============================================================================

export class WallabagService {
  private userId: number;
  private baseUrl: string | null = null;
  private clientId: string | null = null;
  private clientSecret: string | null = null;
  private username: string | null = null;
  private password: string | null = null;

  constructor(userId: number) {
    this.userId = userId;
  }

  // ==========================================================================
  // Configuration Methods
  // ==========================================================================

  /**
   * Check if Wallabag is configured and enabled for this user
   */
  async isEnabled(): Promise<boolean> {
    const enabled = await this.getUserSetting('wallabag_sync_enabled');
    if (enabled !== 'true') {
      return false;
    }

    // Check if all required settings are present
    const [url, clientId, clientSecret, username, password] = await Promise.all([
      this.getUserSetting('wallabag_url'),
      this.getUserSetting('wallabag_client_id'),
      this.getUserSetting('wallabag_client_secret'),
      this.getUserSetting('wallabag_username'),
      this.getUserSetting('wallabag_password'),
    ]);

    return !!(url && clientId && clientSecret && username && password);
  }

  /**
   * Load configuration from user settings
   */
  private async loadConfig(): Promise<boolean> {
    const [url, clientId, clientSecret, username, password] = await Promise.all([
      this.getUserSetting('wallabag_url'),
      this.getUserSetting('wallabag_client_id'),
      this.getUserSetting('wallabag_client_secret'),
      this.getUserSetting('wallabag_username'),
      this.getUserSetting('wallabag_password'),
    ]);

    if (!url || !clientId || !clientSecret || !username || !password) {
      return false;
    }

    this.baseUrl = url.replace(/\/$/, ''); // Remove trailing slash
    this.clientId = clientId;
    this.clientSecret = clientSecret;
    this.username = username;
    this.password = password;

    return true;
  }

  // ==========================================================================
  // OAuth Token Management
  // ==========================================================================

  /**
   * Get a valid access token, refreshing if necessary
   */
  async getAccessToken(): Promise<string | null> {
    if (!(await this.loadConfig())) {
      return null;
    }

    // Check if we have a valid token
    const [accessToken, expiresAt] = await Promise.all([
      this.getUserSetting('wallabag_access_token'),
      this.getUserSetting('wallabag_token_expires_at'),
    ]);

    // If we have a token and it's not expired (with 5-minute buffer), use it
    if (accessToken && expiresAt) {
      const expiryTime = new Date(expiresAt).getTime();
      const now = Date.now();
      const bufferMs = 5 * 60 * 1000; // 5 minutes

      if (expiryTime - now > bufferMs) {
        return accessToken;
      }
    }

    // Try to refresh the token first
    const refreshToken = await this.getUserSetting('wallabag_refresh_token');
    if (refreshToken) {
      const newToken = await this.refreshAccessToken(refreshToken);
      if (newToken) {
        return newToken;
      }
    }

    // If refresh failed, get a new token with password grant
    return this.acquireNewToken();
  }

  /**
   * Acquire a new access token using password grant
   */
  private async acquireNewToken(): Promise<string | null> {
    if (!this.baseUrl || !this.clientId || !this.clientSecret || !this.username || !this.password) {
      console.error('Missing Wallabag configuration');
      return null;
    }

    try {
      const params = new URLSearchParams({
        grant_type: 'password',
        client_id: this.clientId,
        client_secret: this.clientSecret,
        username: this.username,
        password: this.password,
      });

      const response = await fetch(`${this.baseUrl}/oauth/v2/token`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: params.toString(),
      });

      if (!response.ok) {
        const text = await response.text();
        console.error('Failed to acquire Wallabag token:', response.status, text);
        return null;
      }

      const data: TokenResponse = await response.json();
      await this.saveTokens(data);

      return data.access_token;
    } catch (error) {
      console.error('Error acquiring Wallabag token:', error);
      return null;
    }
  }

  /**
   * Refresh an expired access token
   */
  private async refreshAccessToken(refreshToken: string): Promise<string | null> {
    if (!this.baseUrl || !this.clientId || !this.clientSecret) {
      return null;
    }

    try {
      const params = new URLSearchParams({
        grant_type: 'refresh_token',
        client_id: this.clientId,
        client_secret: this.clientSecret,
        refresh_token: refreshToken,
      });

      const response = await fetch(`${this.baseUrl}/oauth/v2/token`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: params.toString(),
      });

      if (!response.ok) {
        console.error('Failed to refresh Wallabag token:', response.status);
        return null;
      }

      const data: TokenResponse = await response.json();
      await this.saveTokens(data);

      return data.access_token;
    } catch (error) {
      console.error('Error refreshing Wallabag token:', error);
      return null;
    }
  }

  /**
   * Save OAuth tokens to user settings
   */
  private async saveTokens(tokenData: TokenResponse): Promise<void> {
    const expiresAt = new Date(Date.now() + tokenData.expires_in * 1000).toISOString();

    await Promise.all([
      this.setUserSetting('wallabag_access_token', tokenData.access_token, true),
      this.setUserSetting('wallabag_refresh_token', tokenData.refresh_token, true),
      this.setUserSetting('wallabag_token_expires_at', expiresAt, false),
    ]);
  }

  // ==========================================================================
  // API Request Wrapper
  // ==========================================================================

  /**
   * Make an authenticated API request to Wallabag
   * Handles token refresh and retries on 401
   */
  private async apiRequest(
    method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
    endpoint: string,
    body?: any,
    retryCount = 0
  ): Promise<any | null> {
    const token = await this.getAccessToken();
    if (!token) {
      console.error('No access token available');
      return null;
    }

    if (!this.baseUrl) {
      console.error('Base URL not configured');
      return null;
    }

    try {
      const url = `${this.baseUrl}/api${endpoint}`;
      const headers: HeadersInit = {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
      };

      const options: RequestInit = {
        method,
        headers,
      };

      if (body && (method === 'POST' || method === 'PATCH')) {
        options.body = JSON.stringify(body);
      }

      const response = await fetch(url, options);

      // Handle 401 - token might be invalid, try refreshing once
      if (response.status === 401 && retryCount === 0) {
        console.log('Got 401, attempting token refresh...');
        // Clear the token and try again
        await this.setUserSetting('wallabag_access_token', '', true);
        return this.apiRequest(method, endpoint, body, retryCount + 1);
      }

      // Handle 429 - rate limited
      if (response.status === 429) {
        const retryAfter = response.headers.get('Retry-After');
        const waitTime = retryAfter ? parseInt(retryAfter) * 1000 : Math.pow(2, retryCount) * 1000;

        if (retryCount < 3) {
          console.log(`Rate limited, waiting ${waitTime}ms...`);
          await this.sleep(waitTime);
          return this.apiRequest(method, endpoint, body, retryCount + 1);
        }
      }

      // Handle server errors with retry
      if (response.status >= 500 && retryCount < 3) {
        const waitTime = Math.pow(2, retryCount) * 1000;
        console.log(`Server error ${response.status}, retrying in ${waitTime}ms...`);
        await this.sleep(waitTime);
        return this.apiRequest(method, endpoint, body, retryCount + 1);
      }

      if (!response.ok) {
        console.error(`Wallabag API error: ${response.status} ${response.statusText}`);
        return null;
      }

      // DELETE requests might not return JSON
      if (method === 'DELETE') {
        return { success: true };
      }

      return response.json();
    } catch (error) {
      console.error('Error making Wallabag API request:', error);
      return null;
    }
  }

  // ==========================================================================
  // Public API Methods
  // ==========================================================================

  /**
   * Test that credentials work and API is accessible
   */
  async testConnection(): Promise<{ success: boolean; error?: string }> {
    try {
      const token = await this.getAccessToken();
      if (!token) {
        return { success: false, error: 'Failed to obtain access token. Check credentials.' };
      }

      // Try to fetch one entry to verify API access
      const response = await this.apiRequest('GET', '/entries.json?perPage=1');
      if (response === null) {
        return { success: false, error: 'API request failed. Check URL and permissions.' };
      }

      return { success: true };
    } catch (error) {
      return { success: false, error: String(error) };
    }
  }

  /**
   * Fetch entries from Wallabag with pagination
   */
  async fetchEntries(since?: string): Promise<WallabagEntry[]> {
    const entries: WallabagEntry[] = [];
    let page = 1;
    let hasMore = true;

    while (hasMore) {
      // Build URL with pagination
      let endpoint = `/entries.json?perPage=30&page=${page}&detail=full`;

      // Add since parameter if provided (unix timestamp)
      if (since) {
        const sinceTimestamp = Math.floor(new Date(since).getTime() / 1000);
        endpoint += `&since=${sinceTimestamp}`;
      }

      const response = await this.apiRequest('GET', endpoint);
      if (!response?._embedded?.items) {
        break;
      }

      entries.push(...response._embedded.items);
      hasMore = page < response.pages;
      page++;

      // Rate limit: 100ms delay between pages
      if (hasMore) {
        await this.sleep(100);
      }
    }

    return entries;
  }

  /**
   * Fetch a single entry by ID
   */
  async fetchEntry(id: number): Promise<WallabagEntry | null> {
    return this.apiRequest('GET', `/entries/${id}.json`);
  }

  /**
   * Create a new entry
   */
  async createEntry(data: CreateEntryData): Promise<WallabagEntry | null> {
    const body: any = {
      url: data.url,
    };

    if (data.title) body.title = data.title;
    if (data.content) body.content = data.content;
    if (data.tags) body.tags = data.tags;
    if (data.archive !== undefined) body.archive = data.archive ? 1 : 0;
    if (data.starred !== undefined) body.starred = data.starred ? 1 : 0;
    if (data.published_at) body.published_at = data.published_at;

    return this.apiRequest('POST', '/entries.json', body);
  }

  /**
   * Update an existing entry
   */
  async updateEntry(id: number, data: UpdateEntryData): Promise<WallabagEntry | null> {
    const body: any = {};

    if (data.title !== undefined) body.title = data.title;
    if (data.content !== undefined) body.content = data.content;
    if (data.tags !== undefined) body.tags = data.tags;
    if (data.archive !== undefined) body.archive = data.archive ? 1 : 0;
    if (data.starred !== undefined) body.starred = data.starred ? 1 : 0;

    return this.apiRequest('PATCH', `/entries/${id}.json`, body);
  }

  /**
   * Delete an entry
   */
  async deleteEntry(id: number): Promise<boolean> {
    const response = await this.apiRequest('DELETE', `/entries/${id}.json`);
    return response !== null;
  }

  /**
   * Add tags to an entry
   */
  async addTags(entryId: number, tags: string): Promise<boolean> {
    const response = await this.apiRequest('POST', `/entries/${entryId}/tags.json`, { tags });
    return response !== null;
  }

  // ==========================================================================
  // Helper Methods
  // ==========================================================================

  /**
   * Get a user setting from the database
   */
  private async getUserSetting(key: string): Promise<string | null> {
    const result = await query(
      'SELECT setting_value FROM user_settings WHERE user_id = $1 AND setting_key = $2',
      [this.userId, key]
    );
    return result.rows[0]?.setting_value || null;
  }

  /**
   * Set a user setting in the database
   */
  private async setUserSetting(key: string, value: string, isSecret: boolean): Promise<void> {
    await query(
      `INSERT INTO user_settings (user_id, setting_key, setting_value, is_secret)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (user_id, setting_key) DO UPDATE SET
         setting_value = EXCLUDED.setting_value,
         updated_at = NOW()`,
      [this.userId, key, value, isSecret]
    );
  }

  /**
   * Sleep for a specified number of milliseconds
   */
  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}
