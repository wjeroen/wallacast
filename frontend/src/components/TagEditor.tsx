import { useEffect, useMemo, useRef, useState } from 'react';
import { Check, Plus, Square, SquareCheck, Tag, X } from 'lucide-react';
import { normalizeTag, reservedTagReason, type TagCount } from '../tags';

// The tag picker popup, shared by the library cards and the fullscreen player.
// Checkbox list of every tag in use (most used first) plus a type-to-filter box
// that doubles as the "create a new tag" input. Saving sends ONE full tag list
// (the backend PATCH and Wallabag's PATCH both replace the whole set).
// Bulk modes: 'add' and 'remove' pick tags for a whole selection instead of
// editing one item's list. The selection starts empty, onSave receives just the
// picked tags, and 'remove' hides the create row (only existing tags can leave).
interface TagEditorProps {
  itemTitle: string;
  initialTags: string[];
  knownTags: TagCount[];
  onSave: (tags: string[]) => Promise<void> | void;
  onClose: () => void;
  mode?: 'edit' | 'add' | 'remove';
  saveLabel?: string;
}

export function TagEditor({ itemTitle, initialTags, knownTags, onSave, onClose, mode = 'edit', saveLabel }: TagEditorProps) {
  const [selected, setSelected] = useState<string[]>(initialTags);
  // Tags created in this session that are not (yet) on any other item, so they stay
  // listed after being toggled off instead of vanishing.
  const [created, setCreated] = useState<string[]>([]);
  const [input, setInput] = useState('');
  const [saving, setSaving] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  // Escape closes without saving (the overlay click does the same).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  const query = normalizeTag(input);
  const reserved = reservedTagReason(input);

  // Union of known tags + the item's own + tags created here, filtered by the box.
  const rows = useMemo(() => {
    const seen = new Set<string>();
    const all: TagCount[] = [];
    for (const k of knownTags) {
      seen.add(k.tag);
      all.push(k);
    }
    for (const t of [...initialTags, ...created]) {
      if (!seen.has(t)) {
        seen.add(t);
        all.push({ tag: t, count: 0 });
      }
    }
    return query ? all.filter((r) => r.tag.includes(query)) : all;
  }, [knownTags, initialTags, created, query]);

  const exactExists = rows.some((r) => r.tag === query);
  const canCreate = !!query && !exactExists && !reserved && mode !== 'remove';

  const toggle = (tag: string) => {
    setSelected((prev) => (prev.includes(tag) ? prev.filter((t) => t !== tag) : [...prev, tag]));
  };

  const create = () => {
    if (!canCreate) return;
    setCreated((prev) => (prev.includes(query) ? prev : [...prev, query]));
    setSelected((prev) => (prev.includes(query) ? prev : [...prev, query]));
    setInput('');
    inputRef.current?.focus();
  };

  const save = async () => {
    setSaving(true);
    try {
      await onSave(selected);
      onClose();
    } catch (err) {
      console.error('Failed to save tags:', err);
      alert('Failed to save tags');
    } finally {
      setSaving(false);
    }
  };

  const changed = mode === 'edit'
    ? selected.length !== initialTags.length || selected.some((t) => !initialTags.includes(t))
    : selected.length > 0;

  return (
    <div className="comment-warning-overlay" onClick={onClose}>
      <div className="comment-warning-modal tag-editor" onClick={(e) => e.stopPropagation()}>
        <div className="tag-editor-header">
          <Tag size={16} />
          <span className="tag-editor-title" title={itemTitle}>{itemTitle}</span>
          <button className="tag-editor-close" onClick={onClose} title="Close">
            <X size={16} />
          </button>
        </div>
        <input
          ref={inputRef}
          type="text"
          className="tag-editor-input"
          placeholder={mode === 'remove' ? 'Find a tag…' : 'Find or create a tag…'}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              // Enter on an exact match toggles it; otherwise creates.
              if (exactExists) toggle(query);
              else create();
            }
          }}
          autoCapitalize="off"
          autoCorrect="off"
          enterKeyHint="done"
        />
        {reserved && <p className="tag-editor-hint tag-editor-error">{reserved}</p>}
        <div className="tag-editor-list">
          {canCreate && (
            <button className="tag-editor-row tag-editor-create" onClick={create}>
              <Plus size={16} />
              <span>Create tag “{query}”</span>
            </button>
          )}
          {rows.map((r) => {
            const on = selected.includes(r.tag);
            return (
              <button
                key={r.tag}
                className={`tag-editor-row${on ? ' selected' : ''}`}
                onClick={() => toggle(r.tag)}
              >
                {on ? <SquareCheck size={16} /> : <Square size={16} />}
                <span className="tag-editor-row-label">#{r.tag}</span>
                {r.count > 0 && <span className="tag-editor-row-count">{r.count}</span>}
              </button>
            );
          })}
          {rows.length === 0 && !canCreate && (
            <p className="tag-editor-hint">
              {query ? 'No matching tags.' : 'No tags yet. Type a name above to create one.'}
            </p>
          )}
        </div>
        <div className="tag-editor-buttons">
          <button className="comment-warning-btn cancel" onClick={onClose} disabled={saving}>
            Cancel
          </button>
          <button className="comment-warning-btn include" onClick={save} disabled={saving || !changed}>
            <Check size={14} style={{ marginRight: 6, verticalAlign: '-2px' }} />
            {saving ? 'Saving…' : (saveLabel || 'Save')}
          </button>
        </div>
      </div>
    </div>
  );
}
