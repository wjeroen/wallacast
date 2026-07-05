import { useState, useEffect } from 'react';
import { Newspaper, NotebookPen, Upload, Podcast } from 'lucide-react';
import { contentAPI } from '../api';
import { markdownToHtml } from '../markdown';
import type { ContentItem } from '../types';

type ContentType = 'article' | 'text' | 'upload' | 'podcast_episode';
type TextFormat = 'markdown' | 'html';

interface AddTabProps {
  onContentAdded: (item: ContentItem) => void;
}

export function AddTab({ onContentAdded }: AddTabProps) {
  const [contentType, setContentType] = useState<ContentType>('article');
  const [url, setUrl] = useState('');
  const [title, setTitle] = useState('');
  const [text, setText] = useState('');
  const [textFormat, setTextFormat] = useState<TextFormat>('markdown');
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState('');
  const [uploadedContent, setUploadedContent] = useState<string>('');
  const [uploadedFileName, setUploadedFileName] = useState<string>('');

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
      setUploadedContent(event.target?.result as string || '');
    };
    reader.readAsText(file);

    // Auto-fill title from filename (strip extension)
    if (!title) {
      setTitle(file.name.replace(/\.(html|htm)$/i, ''));
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setMessage('');

    try {
      const data: any = {
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
        data.content = textFormat === 'markdown' ? markdownToHtml(text) : text;
      } else if (contentType === 'upload') {
        if (!uploadedContent || !title) {
          setMessage('Please select a file and enter a title');
          setLoading(false);
          return;
        }
        data.type = 'text';
        data.title = title;
        data.content = uploadedContent;
      } else if (contentType === 'podcast_episode') {
        if (!url) {
          setMessage('Audio URL is required for podcasts');
          setLoading(false);
          return;
        }
        // Backend stores the episode's source media under audio_url (see content.ts POST handler).
        data.audio_url = url;
      }

      const response = await contentAPI.create(data);
      setMessage('Content saved successfully!');

      // Add the new item to the store
      onContentAdded(response.data);

      setUrl('');
      setTitle('');
      setText('');
      setUploadedContent('');
      setUploadedFileName('');
    } catch (error: any) {
      console.error('Failed to save content:', error);
      const errorMsg = error?.response?.data?.error || 'Failed to save content. Please try again.';
      setMessage(errorMsg);
    } finally {
      setLoading(false);
    }
  };

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
                  ? 'Write in Markdown (works great with Obsidian). It is converted to formatted text automatically.'
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
            </div>
          </>
        )}

        {contentType === 'upload' && (
          <>
            <div className="form-group">
              <label>HTML File</label>
              <input
                type="file"
                accept=".html,.htm"
                onChange={handleFileSelect}
              />
              {uploadedFileName && (
                <p style={{ fontSize: '0.85rem', color: '#94a3b8', marginTop: '0.5rem' }}>
                  Selected: {uploadedFileName}
                </p>
              )}
              {!uploadedFileName && (
                <p style={{ fontSize: '0.85rem', color: '#64748b', marginTop: '0.5rem' }}>
                  Supports HTML files. For PDFs, use an online PDF-to-HTML converter first.
                </p>
              )}
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
          <li>Upload HTML files to convert them to audio</li>
          <li>Text content can be converted to audio using AI text-to-speech</li>
          <li>For podcasts, use the Feed tab to subscribe to your favorite shows</li>
        </ul>
      </div>
    </div>
  );
}
