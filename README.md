# Readcast

A unified web application for reading and listening to articles and podcasts. Readcast combines the functionality of read-it-later services like Wallabag/Pocket with a full-featured podcast player.

## Features

- **Unified Content Management**: Treat articles and podcasts the same way - read or listen to both
- **AI-Powered Audio**:
  - Convert articles to speech using ElevenLabs TTS
  - Transcribe podcast episodes using OpenAI Whisper
- **Click-to-Seek**: Click on any word in the transcript/text to jump to that position in the audio
- **Full Podcast Support**:
  - Subscribe to podcasts via RSS
  - Search for new podcasts
  - Auto-fetch new episodes
- **Article Saving**:
  - Save articles via URL
  - Browser extension support (coming soon)
  - Android share target support (coming soon)
- **Advanced Playback Features**:
  - Variable playback speed (0.5x - 2x)
  - Sleep timer
  - Queue management
  - Playback position memory
- **Organization Tools**:
  - Mark as favorite
  - Archive items
  - Filter by type
  - Mark as read/listened
- **Cross-Device Sync**: Access your content from anywhere

## Project Structure

```
readcast/
├── frontend/          # React + TypeScript frontend
│   ├── src/
│   │   ├── components/   # React components
│   │   ├── types.ts      # TypeScript interfaces
│   │   ├── api.ts        # API client
│   │   ├── App.tsx       # Main app component
│   │   └── App.css       # Styling
│   └── package.json
│
└── backend/           # Node.js + Express backend
    ├── src/
    │   ├── database/     # Database schema and connection
    │   ├── routes/       # API routes
    │   ├── services/     # Business logic (TTS, transcription, etc.)
    │   └── index.ts      # Server entry point
    └── package.json
```

## Tech Stack

### Frontend
- React 18 with TypeScript
- Vite for build tooling
- Axios for API calls
- Lucide React for icons

### Backend
- Node.js with Express
- PostgreSQL database
- OpenAI API (Whisper for transcription)
- ElevenLabs API (TTS for articles)

## Setup

### Prerequisites
- Node.js 18+ and npm
- PostgreSQL 12+
- OpenAI API key (optional, for podcast transcription)
- ElevenLabs API key (optional, for article TTS)

### Backend Setup

1. Navigate to the backend directory:
```bash
cd backend
```

2. Install dependencies:
```bash
npm install
```

3. Create a `.env` file based on `.env.example`:
```bash
cp .env.example .env
```

4. Edit `.env` and add your configuration:
```env
DB_HOST=localhost
DB_PORT=5432
DB_NAME=readcast
DB_USER=postgres
DB_PASSWORD=your_password

OPENAI_API_KEY=your_openai_key
ELEVENLABS_API_KEY=your_elevenlabs_key

PORT=3001
```

5. Create the PostgreSQL database:
```bash
createdb readcast
```

6. Start the development server:
```bash
npm run dev
```

The backend will run on `http://localhost:3001` and automatically initialize the database schema.

### Frontend Setup

1. Navigate to the frontend directory:
```bash
cd frontend
```

2. Install dependencies:
```bash
npm install
```

3. Create a `.env` file:
```bash
cp .env.example .env
```

4. Start the development server:
```bash
npm run dev
```

The frontend will run on `http://localhost:5173`.

## Usage

### Adding Content

1. Click the **+** button in the bottom navigation
2. Choose content type (Article, Text, PDF, or Podcast)
3. Enter the URL or paste content
4. Click "Save Content"

### Subscribing to Podcasts

1. Go to the **Feed** tab (left navigation)
2. Use the search bar to find podcasts
3. Click "Subscribe" on any podcast
4. New episodes will be automatically fetched

### Playing Content

1. Go to the **Library** tab (right navigation)
2. Click on any content item to open the player
3. Use playback controls to play, pause, skip, adjust speed
4. Click on transcript words to seek to that position
5. Set a sleep timer if desired

### Managing Content

In the Library tab, you can:
- **Star** items to mark as favorite
- **Archive** items you've finished
- **Delete** items you no longer need
- **Filter** by type, favorites, or archived status
- **Generate Audio** for articles (if not already generated)

## Roadmap

- [ ] Chrome extension for one-click article saving
- [ ] Android app with share target support
- [ ] Better article parsing (integrate with Readability)
- [ ] Support for more content types (YouTube videos, PDFs with OCR)
- [ ] Improved transcript synchronization with word-level timestamps
- [ ] Playlist/collection management
- [ ] Export functionality

## License

MIT