import { useState, useEffect } from 'react';
import { Newspaper, NotebookPen, Upload, Podcast } from 'lucide-react';
import { contentAPI } from '../api';
import { markdownToHtml, parseFrontmatter, splitExportedComments, splitExportedSummary, stripLeadingTitle } from '../markdown';
import { parseTagInput } from '../tags';
import type { ContentItem } from '../types';

type ContentType = 'article' | 'text' | 'upload' | 'podcast_episode';
type TextFormat = 'markdown' | 'html';

interface AddTabProps {
  onContentAdded: (item: ContentItem) => void;
}

// What a leading Obsidian-properties block (YAML frontmatter) contributed: shown as a
// note under the field and applied on save. A "Copy content" export from Wallacast
// starts with exactly such a block, so pasting one back re-creates the item with its
// title, author, date, tags, description, source URL, summary, and comments.
interface ImportMeta {
  key: string;            // the raw frontmatter text, so one block is applied only once
  source?: string;        // http(s) URL: the item is created as an article with that URL
  description?: string;
  detected: string[];     // field names filled in, for the notice
}

function toDateInput(value: string): string {
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return value;
  const d = new Date(value);
  return isNaN(d.getTime()) ? '' : d.toISOString().slice(0, 10);
}

function metaString(v: string | string[] | undefined): string {
  if (Array.isArray(v)) return v.join(', ');
  return (v || '').trim();
}

export function AddTab({ onContentAdded }: AddTabProps) {
  const [contentType, setContentType] = useState<ContentType>('article');
  const [url, setUrl] = useState('');
  const [title, setTitle] = useState('');
  const [text, setText] = useState('');
  const [author, setAuthor] = useState('');
  const [publishedDate, setPublishedDate] = useState('');
  const [tagsInput, setTagsInput] = useState('');
  const [textFormat, setTextFormat] = useState<TextFormat>('markdown');
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState('');
  const [uploadedContent, setUploadedContent] = useState<string>('');
  const [uploadedFileName, setUploadedFileName] = useState<string>('');
  const [importMeta, setImportMeta] = useState<ImportMeta | null>(null);

  // Clear upload state when switching away from upload tab
  useEffect(() => {
    if (contentType !== 'upload') {
      setUploadedContent('');
      setUploadedFileName('');
    }
  }, [contentType]);

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    setUploadedFileName(file.name);

    const reader = new FileReader();
    reader.onload = (event) => {
      const content = (event.target?.result as string) || '';
      setUploadedContent(content);
      // Auto-fill title from filename (strip extension), unless the file carries an
      // Obsidian-properties title, which the frontmatter effect below fills in instead.
      const fm = parseFrontmatter(content);
      const fmTitle = fm ? metaString(fm.meta.title) : '';
      if (!fmTitle) {
        setTitle(prev => prev || file.name.replace(/\.(html|htm|md|markdown|txt)$/i, ''));
      }
    };
    reader.readAsText(file);
  };

  // Markdown/plain-text uploads get the same Markdown->HTML conversion as the
  // Text tab; .html/.htm files pass through raw (backend sanitizes either way).
  const isMarkdownUpload = /\.(md|markdown|txt)$/i.test(uploadedFileName);

  // The Markdown currently being edited or uploaded (the only place frontmatter can appear)
  const markdownSource =
    contentType === 'text' && textFormat === 'markdown' ? text
    : contentType === 'upload' && isMarkdownUpload ? uploadedContent
    : '';

  // Apply Obsidian properties once per distinct frontmatter block: fill the fields the
  // user has not typed into yet. Editing a field afterwards is never overwritten.
  useEffect(() => {
    const fm = parseFrontmatter(markdownSource);
    if (!fm) {
      if (importMeta) setImportMeta(null);
      return;
    }
    const key = markdownSource.slice(0, markdownSource.length - fm.body.length);
    if (importMeta?.key === key) return;

    const m = fm.meta;
    const detected: string[] = [];
    const t = metaString(m.title);
    if (t && !title) { setTitle(t); detected.push('title'); }
    const a = metaString(m.author);
    if (a && !author) { setAuthor(a); detected.push('author'); }
    const p = metaString(m.published || m.date || m.published_at);
    const pd = p ? toDateInput(p) : '';
    if (pd && !publishedDate) { setPublishedDate(pd); detected.push('date'); }
    const rawTags = m.tags ?? m.tag;
    const tagList = Array.isArray(rawTags) ? rawTags : rawTags ? String(rawTags).split(',') : [];
    const cleaned = parseTagInput(tagList.join(','));  // type tags (article/text/podcast) are dropped
    if (cleaned.length > 0 && !tagsInput) {
      setTagsInput(cleaned.join(', '));
      detected.push(`${cleaned.length} tag${cleaned.length === 1 ? '' : 's'}`);
    }
    const src = metaString(m.source || m.url);
    const source = /^https?:\/\//i.test(src) ? src : undefined;
    if (source) detected.push('source URL');
    const description = metaString(m.description) || undefined;
    if (description) detected.push('description');
    if (splitExportedSummary(fm.body).summary) detected.push('summary');
    if (splitExportedComments(fm.body).comments.length > 0) detected.push('comments');
    setImportMeta({ key, source, description, detected });
  }, [markdownSource]); // eslint-disable-line react-hooks/exhaustive-deps

  // Turn Markdown (possibly a Wallacast export) into the POST payload: strip the
  // properties block and a repeated "# Title", split an exported "# Comments" section
  // back into structured comments, convert the rest to HTML. A source URL makes it an
  // article (kept for provenance, nothing is fetched; "Refetch from web" still works).
  const applyMarkdownImport = (data: Record<string, unknown>, md: string) => {
    const fm = parseFrontmatter(md);
    let body = fm ? fm.body : md;
    if (fm) {
      // Summary blocks sit between the properties and the title in an export
      const s = splitExportedSummary(body);
      body = s.body;
      if (s.summary) data.summary = s.summary;
      if (s.comment_summary) data.comment_summary = s.comment_summary;
    }
    body = stripLeadingTitle(body, title);
    const { body: bodyWithoutComments, comments } = splitExportedComments(body);
    data.content = markdownToHtml(bodyWithoutComments);
    if (comments.length > 0) data.comments = comments;
    if (fm) {
      const src = metaString(fm.meta.source || fm.meta.url);
      if (/^https?:\/\//i.test(src)) {
        data.type = 'article';
        data.url = src;
      }
      const desc = metaString(fm.meta.description);
      if (desc && !data.description) data.description = desc;
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setMessage('');

    try {
      const data: Record<string, unknown> = {
        type: contentType,
      };

      // Only send title if user provided one (allow backend to auto-detect)
      if (title) {
        data.title = title;
      }

      if (contentType === 'article') {
        if (!url) {
          setMessage('URL is required for articles');
          setLoading(false);
          return;
        }
        data.url = url;
      } else if (contentType === 'text') {
        // Markdown is the friendly default. Convert it to the HTML we store/display.
        // HTML mode passes the text straight through (backend cleans it).
        if (textFormat === 'markdown') applyMarkdownImport(data, text);
        else data.content = text;
        if (author) data.author = author;
        if (publishedDate) data.published_at = publishedDate;
        data.tags = parseTagInput(tagsInput);
      } else if (contentType === 'upload') {
        if (!uploadedContent || !title) {
          setMessage('Please select a file and enter a title');
          setLoading(false);
          return;
        }
        data.type = 'text';
        data.title = title;
        if (isMarkdownUpload) applyMarkdownImport(data, uploadedContent);
        else data.content = uploadedContent;
        if (author) data.author = author;
        if (publishedDate) data.published_at = publishedDate;
        data.tags = parseTagInput(tagsInput);
      } else if (contentType === 'podcast_episode') {
        if (!url) {
          setMessage('Audio URL is required for podcasts');
          setLoading(false);
          return;
        }
        // Backend stores the episode's source media under audio_url (see content.ts POST handler).
        data.audio_url = url;
      }

      const response = await contentAPI.create(data as Partial<ContentItem>);
      setMessage('Content saved successfully!');

      // Add the new item to the store
      onContentAdded(response.data);

      setUrl('');
      setTitle('');
      setText('');
      setAuthor('');
      setPublishedDate('');
      setTagsInput('');
      setUploadedContent('');
      setUploadedFileName('');
      setImportMeta(null);
    } catch (error: any) {
      console.error('Failed to save content:', error);
      const errorMsg = error?.response?.data?.error || 'Failed to save content. Please try again.';
      setMessage(errorMsg);
    } finally {
      setLoading(false);
    }
  };

  const importNotice = importMeta && importMeta.detected.length > 0 && (
    <p className="import-notice">
      Obsidian properties found: {importMeta.detected.join(', ')}.
      {importMeta.source ? ' It will be saved as an article with that source URL.' : ''}
    </p>
  );

  const tagsField = (
    <div className="form-group">
      <label htmlFor="tags">Tags (optional, comma-separated)</label>
      <input
        id="tags"
        type="text"
        value={tagsInput}
        onChange={(e) => setTagsInput(e.target.value)}
        placeholder="e.g. ai, economics"
        autoCapitalize="off"
      />
    </div>
  );

  return (
    <div className="add-tab">
      <h2>Add New Content</h2>

      <div className="content-type-selector">
        <button
          className={contentType === 'article' ? 'active' : ''}
          onClick={() => setContentType('article')}
        >
          <Newspaper size={20} />
          <span>Article</span>
        </button>
        <button
          className={contentType === 'text' ? 'active' : ''}
          onClick={() => setContentType('text')}
        >
          <NotebookPen size={20} />
          <span>Text</span>
        </button>
        <button
          className={contentType === 'upload' ? 'active' : ''}
          onClick={() => setContentType('upload')}
        >
          <Upload size={20} />
          <span>Upload</span>
        </button>
        <button
          className={contentType === 'podcast_episode' ? 'active' : ''}
          onClick={() => setContentType('podcast_episode')}
        >
          <Podcast size={20} />
          <span>Podcast</span>
        </button>
      </div>

      <form onSubmit={handleSubmit}>
        {contentType === 'article' && (
          <>
            <div className="form-group">
              <label htmlFor="url">Article URL</label>
              <input
                id="url"
                type="url"
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                placeholder="https://example.com/article"
                required
              />
            </div>
            <div className="form-group">
              <label htmlFor="title">Title (optional)</label>
              <input
                id="title"
                type="text"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder="Will be auto-detected if left empty"
              />
            </div>
          </>
        )}

        {contentType === 'text' && (
          <>
            <div className="form-group">
              <label htmlFor="title">Title</label>
              <input
                id="title"
                type="text"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder="Enter a title for your text"
                required
              />
            </div>
            <div className="form-group">
              <label htmlFor="author">Author (optional)</label>
              <input
                id="author"
                type="text"
                value={author}
                onChange={(e) => setAuthor(e.target.value)}
              />
            </div>
            <div className="form-group">
              <label htmlFor="published-date">Date (optional)</label>
              <input
                id="published-date"
                type="date"
                value={publishedDate}
                onChange={(e) => setPublishedDate(e.target.value)}
              />
            </div>
            {tagsField}
            <div className="form-group">
              <label>Format</label>
              <div className="text-format-toggle">
                <button
                  type="button"
                  className={textFormat === 'markdown' ? 'active' : ''}
                  onClick={() => setTextFormat('markdown')}
                >
                  Markdown
                </button>
                <button
                  type="button"
                  className={textFormat === 'html' ? 'active' : ''}
                  onClick={() => setTextFormat('html')}
                >
                  HTML
                </button>
              </div>
              <p style={{ fontSize: '0.85rem', color: '#64748b', marginTop: '0.5rem' }}>
                {textFormat === 'markdown'
                  ? 'Write in Markdown (works great with Obsidian). It is converted to formatted text automatically. A leading properties block (title, author, tags, ...) fills in the fields above.'
                  : 'Paste raw HTML. Stored as-is (scripts/styles are stripped).'}
              </p>
            </div>
            <div className="form-group">
              <label htmlFor="text">{textFormat === 'markdown' ? 'Markdown Content' : 'HTML Content'}</label>
              <textarea
                id="text"
                value={text}
                onChange={(e) => setText(e.target.value)}
                placeholder={textFormat === 'markdown' ? '# My note\n\nWrite **Markdown** here...' : '<h1>My note</h1>\n<p>Write HTML here...</p>'}
                rows={10}
                required
              />
              {textFormat === 'markdown' && importNotice}
            </div>
          </>
        )}

        {contentType === 'upload' && (
          <>
            <div className="form-group">
              <label>File</label>
              <input
                type="file"
                accept=".html,.htm,.md,.markdown,.txt"
                onChange={handleFileSelect}
              />
              {uploadedFileName && (
                <p style={{ fontSize: '0.85rem', color: '#94a3b8', marginTop: '0.5rem' }}>
                  Selected: {uploadedFileName}{isMarkdownUpload ? ' (converted from Markdown)' : ''}
                </p>
              )}
              {!uploadedFileName && (
                <p style={{ fontSize: '0.85rem', color: '#64748b', marginTop: '0.5rem' }}>
                  Supports HTML and Markdown (.md, .txt) files. For PDFs, use an online PDF-to-HTML converter first.
                </p>
              )}
              {isMarkdownUpload && importNotice}
            </div>
            <div className="form-group">
              <label>Title (required)</label>
              <input
                type="text"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder="Enter a title..."
                required
              />
            </div>
            <div className="form-group">
              <label htmlFor="upload-author">Author (optional)</label>
              <input
                id="upload-author"
                type="text"
                value={author}
                onChange={(e) => setAuthor(e.target.value)}
              />
            </div>
            <div className="form-group">
              <label htmlFor="upload-date">Date (optional)</label>
              <input
                id="upload-date"
                type="date"
                value={publishedDate}
                onChange={(e) => setPublishedDate(e.target.value)}
              />
            </div>
            {tagsField}
          </>
        )}

        {contentType === 'podcast_episode' && (
          <>
            <div className="form-group">
              <label htmlFor="url">Audio URL</label>
              <input
                id="url"
                type="url"
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                placeholder="https://example.com/episode.mp3"
                required
              />
            </div>
            <div className="form-group">
              <label htmlFor="title">Episode Title</label>
              <input
                id="title"
                type="text"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder="Episode title"
                required
              />
            </div>
          </>
        )}

        {message && (
          <div className={`message ${message.includes('success') ? 'success' : 'error'}`}>
            {message}
          </div>
        )}

        <button type="submit" disabled={loading} className="submit-btn">
          {loading ? 'Saving...' : 'Save Content'}
        </button>
      </form>

      <div className="quick-tips">
        <h3>Quick Tips</h3>
        <ul>
          <li>Articles will be automatically parsed and formatted for easy reading</li>
          <li>Upload HTML or Markdown files to convert them to audio</li>
          <li>Text content can be converted to audio using AI text-to-speech</li>
          <li>Paste or upload a note with Obsidian properties (or a Wallacast "Copy content" export) and the title, author, date, tags, summary, and comments come along</li>
          <li>For podcasts, use the Feed tab to subscribe to your favorite shows</li>
        </ul>
      </div>
    </div>
  );
}
