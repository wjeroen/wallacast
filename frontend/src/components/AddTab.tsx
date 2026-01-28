import { useState } from 'react';
import { Newspaper, NotebookPen, FileText, Podcast } from 'lucide-react';
import { contentAPI } from '../api';
import type { ContentItem } from '../types';

type ContentType = 'article' | 'text' | 'pdf' | 'podcast_episode';

interface AddTabProps {
  onContentAdded: (item: ContentItem) => void;
}

export function AddTab({ onContentAdded }: AddTabProps) {
  const [contentType, setContentType] = useState<ContentType>('article');
  const [url, setUrl] = useState('');
  const [title, setTitle] = useState('');
  const [text, setText] = useState('');
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState('');

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
        data.content = text;
      }

      const response = await contentAPI.create(data);
      setMessage('Content saved successfully!');

      // Add the new item to the store
      onContentAdded(response.data);

      setUrl('');
      setTitle('');
      setText('');
    } catch (error) {
      console.error('Failed to save content:', error);
      setMessage('Failed to save content. Please try again.');
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
          className={contentType === 'pdf' ? 'active' : ''}
          onClick={() => setContentType('pdf')}
        >
          <FileText size={20} />
          <span>PDF</span>
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
              <label htmlFor="text">Text Content</label>
              <textarea
                id="text"
                value={text}
                onChange={(e) => setText(e.target.value)}
                placeholder="Paste or type your text here..."
                rows={10}
                required
              />
            </div>
          </>
        )}

        {contentType === 'pdf' && (
          <>
            <div className="form-group">
              <label htmlFor="url">PDF URL</label>
              <input
                id="url"
                type="url"
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                placeholder="https://example.com/document.pdf"
                required
              />
            </div>
            <div className="form-group">
              <label htmlFor="title">Title</label>
              <input
                id="title"
                type="text"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder="PDF document title"
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
          <li>Text content can be converted to audio using AI text-to-speech</li>
          <li>For podcasts, use the Feed tab to subscribe to your favorite shows</li>
          <li>Saved content is accessible across all your devices</li>
        </ul>
      </div>
    </div>
  );
}
