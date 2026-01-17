import { create } from 'zustand';
import { authAPI, setTokens, clearTokens, getAccessToken } from '../api';
import type { User } from '../types';

interface AuthStore {
  user: User | null;
  isAuthenticated: boolean;
  isLoading: boolean;
  error: string | null;

  login: (username: string, password: string) => Promise<boolean>;
  register: (username: string, password: string, displayName?: string, email?: string) => Promise<boolean>;
  logout: () => Promise<void>;
  checkAuth: () => Promise<void>;
  clearError: () => void;
}

export const useAuthStore = create<AuthStore>((set) => ({
  user: null,
  isAuthenticated: false,
  isLoading: true, // Start true to check auth on load
  error: null,

  login: async (username: string, password: string) => {
    set({ isLoading: true, error: null });
    try {
      const response = await authAPI.login(username, password);
      const { accessToken, refreshToken, user } = response.data;
      setTokens(accessToken, refreshToken);
      set({ user, isAuthenticated: true, isLoading: false });
      return true;
    } catch (error: any) {
      // Handle 503 Service Unavailable (database not ready)
      if (error.response?.status === 503) {
        set({ error: 'Service is starting up, please wait a moment and try again', isLoading: false });
        return false;
      }
      const message = error.response?.data?.error || 'Login failed';
      set({ error: message, isLoading: false });
      return false;
    }
  },

  register: async (username: string, password: string, displayName?: string, email?: string) => {
    set({ isLoading: true, error: null });
    try {
      const response = await authAPI.register(username, password, displayName, email);
      const { accessToken, refreshToken, user } = response.data;
      setTokens(accessToken, refreshToken);
      set({ user, isAuthenticated: true, isLoading: false });
      return true;
    } catch (error: any) {
      // Handle 503 Service Unavailable (database not ready)
      if (error.response?.status === 503) {
        set({ error: 'Service is starting up, please wait a moment and try again', isLoading: false });
        return false;
      }
      const message = error.response?.data?.error || 'Registration failed';
      set({ error: message, isLoading: false });
      return false;
    }
  },

  logout: async () => {
    try {
      await authAPI.logout();
    } catch {
      // Ignore logout errors
    }
    clearTokens();
    set({ user: null, isAuthenticated: false });
  },

  checkAuth: async () => {
    const token = getAccessToken();
    if (!token) {
      set({ isLoading: false, isAuthenticated: false });
      return;
    }

    // Retry logic for 503 errors during startup
    const maxRetries = 5;
    let delay = 2000;

    for (let attempt = 0; attempt < maxRetries; attempt++) {
      try {
        const response = await authAPI.getMe();
        set({ user: response.data.user, isAuthenticated: true, isLoading: false });
        return;
      } catch (error: any) {
        // If service is starting up, wait and retry
        if (error.response?.status === 503 && attempt < maxRetries - 1) {
          await new Promise(resolve => setTimeout(resolve, delay));
          delay = Math.min(delay * 1.5, 10000);
          continue;
        }
        // Other errors or max retries reached
        clearTokens();
        set({ user: null, isAuthenticated: false, isLoading: false });
        return;
      }
    }
  },

  clearError: () => set({ error: null }),
}));
