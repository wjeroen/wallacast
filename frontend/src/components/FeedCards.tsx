import { Podcast, Newspaper, SquareArrowOutUpRight } from 'lucide-react';
import { cleanHtml, formatDuration, getDomainFromUrl } from '../format';
import type { Podcast as PodcastType } from '../types';

// Shape of a feed item (episode or article) as used by the Feed tab. The API
// returns these untyped; this covers every field the cards and handlers read.
export interface FeedEpisode {
  title: string;
  description?: string;
  url?: string;
  audio_url?: string;
  preview_picture?: string;
  published_at?: string;
  duration?: number;
  item_type?: 'podcast_episode' | 'article';
  author?: string;
  podcast_title?: string;
  podcast_id?: number | null;
}

// Shared cards for the Feed tab. The same markup used to be copy-pasted in
// several places (search results, subscriptions list, expanded podcast card,
// and three episode/article lists), these two components are the single
// source of truth now. Same CSS classes as before, so nothing changes visually.

function FeedTypeIcon({ type }: { type?: string }) {
  return (
    <span className="type">
      {type === 'podcast' && <Podcast size={16} className="icon-podcast" />}
      {type === 'newsletter' && <Newspaper size={16} className="icon-article" />}
    </span>
  );
}

// A podcast/newsletter feed card. Variants:
// - 'search-result': clickable row with truncated description (search results list)
// - 'subscription':  clickable row without description, thumbnail outside content-info
//                    (collapsible subscriptions list)
// - 'expanded':      the big selected-feed card with the FULL description
// The action button (subscribe/unsubscribe) is rendered by the caller and
// passed in, so each context keeps its exact button and handler.
export function FeedCard({ feed, variant, onClick, actionButton }: {
  feed: PodcastType;
  variant: 'search-result' | 'subscription' | 'expanded';
  onClick?: () => void;
  actionButton: React.ReactNode;
}) {
  const className = variant === 'expanded'
    ? 'content-card selected-podcast-card'
    : 'content-card podcast-list-card';

  const thumbnail = feed.preview_picture && (
    <img src={feed.preview_picture} alt={feed.title} className="thumbnail" />
  );

  return (
    <div
      className={className}
      onClick={onClick}
      style={onClick ? { cursor: 'pointer' } : undefined}
    >
      {variant === 'subscription' && thumbnail}
      <div className="content-info">
        {variant !== 'subscription' && thumbnail}
        <h3>{feed.title}</h3>
        <p className="author">{feed.author}</p>
        {variant === 'search-result' && feed.description && (
          <p className="description">{cleanHtml(feed.description).slice(0, 280)}...</p>
        )}
        {variant === 'expanded' && feed.description && (
          <p className="description selected-podcast-description">
            {cleanHtml(feed.description)}
          </p>
        )}
        <div className="metadata">
          <FeedTypeIcon type={feed.type} />
        </div>
      </div>
      <div className="content-actions" onClick={(e) => e.stopPropagation()}>
        {actionButton}
      </div>
    </div>
  );
}

// An episode (podcast) or article (newsletter/blog) row with an
// add-to-library action button rendered by the caller.
// `showShowName` is the "Recent Updates" variant: the author line reads
// "author • show name • date" instead of "author • date • duration".
export function FeedEpisodeCard({ episode, showShowName = false, actionButton }: {
  episode: FeedEpisode;
  showShowName?: boolean;
  actionButton: React.ReactNode;
}) {
  return (
    <div className="content-card">
      <div className="content-info">
        {episode.preview_picture && (
          <img src={episode.preview_picture} alt={episode.title} className="thumbnail" />
        )}
        <h3>{episode.title}</h3>
        {showShowName ? (
          <p className="author">
            {episode.author && <>{episode.author} • </>}
            {episode.podcast_title}
            {episode.published_at && <> • {new Date(episode.published_at).toLocaleDateString('en-GB')}</>}
          </p>
        ) : (
          <p className="author">
            {episode.author && <>{episode.author} • </>}
            {episode.published_at && new Date(episode.published_at).toLocaleDateString('en-GB')}
            {episode.duration && <> • {formatDuration(episode.duration)}</>}
          </p>
        )}
        {episode.url && episode.item_type === 'article' && (
          <p className="content-source-link">
            <a href={episode.url} target="_blank" rel="noopener noreferrer" onClick={(e) => e.stopPropagation()}>
              {getDomainFromUrl(episode.url)}
              <SquareArrowOutUpRight size={12} style={{ marginLeft: '0.25rem' }} />
            </a>
          </p>
        )}
        {episode.description && (
          <p className="description">{cleanHtml(episode.description).slice(0, 280)}...</p>
        )}
        <div className="metadata">
          <span className="type">
            {episode.item_type === 'podcast_episode' && <Podcast size={16} className="icon-podcast" />}
            {episode.item_type === 'article' && <Newspaper size={16} className="icon-article" />}
          </span>
          {episode.duration && <span className="duration">{formatDuration(episode.duration)}</span>}
        </div>
      </div>
      <div className="content-actions">
        {actionButton}
      </div>
    </div>
  );
}
