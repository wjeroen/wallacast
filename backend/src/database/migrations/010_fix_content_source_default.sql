-- Fix content_source column default: should be 'wallacast' since wallabag-sync
-- explicitly sets 'wallabag'. Any other insertion path is wallacast.
ALTER TABLE content_items
ALTER COLUMN content_source SET DEFAULT 'wallacast';

-- Fix existing items: anything without a wallabag_id was created by wallacast
UPDATE content_items
SET content_source = 'wallacast'
WHERE wallabag_id IS NULL AND content_source = 'wallabag';
