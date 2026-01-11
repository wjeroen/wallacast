# Readcast

A unified web application for reading and listening to articles and podcasts. Readcast combines the functionality of read-it-later services like Wallabag/Pocket with a full-featured podcast player.

## Features

- **Unified Content Management**: Treat articles and podcasts the same way - read or listen to both
- **AI-Powered Audio**:
  - Convert articles to speech using OpenAI TTS (gpt-4o-mini-tts)
  - **Unlimited article length** - automatically splits long articles into chunks and concatenates audio
  - Transcribe podcast episodes using OpenAI Whisper (gpt-4o-mini-transcribe)
  - **Unlimited podcast length** - automatically compresses and splits large episodes for transcription
- **Click-to-Seek**: Click on any word in the transcript/text to jump to that position in the audio
- **Full Podcast Support**:
  - Subscribe to podcasts via RSS
  - Search for new podcasts
  - Manually select episodes to add to library
- **Article Saving**:
  - Save articles via URL
  - Automatic content extraction from web pages
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
- **Security**:
  - HTTP Basic Auth protects all API endpoints
  - OpenAI API key stored securely in environment variables only
- **Cross-Device Sync**: Deploy to Railway and access your content from anywhere

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
- Axios for API calls (with HTTP Basic Auth support)
- Lucide React for icons
- Responsive CSS for mobile-first design

### Backend
- Node.js 22 with Express
- PostgreSQL database
- OpenAI API:
  - Whisper (gpt-4o-mini-transcribe) for podcast transcription
  - TTS (gpt-4o-mini-tts) for article audio generation
- ffmpeg for audio processing:
  - Splitting and compression for large podcast transcription
  - Audio concatenation for long article TTS
- express-basic-auth for API security
- fluent-ffmpeg for Node.js ffmpeg integration

## Setup

### Prerequisites
- Node.js 22+ and npm
- PostgreSQL 12+
- ffmpeg (required for audio processing)
- OpenAI API key (required for transcription and TTS)

#### Installing ffmpeg

**macOS:**
```bash
brew install ffmpeg
```

**Ubuntu/Debian:**
```bash
sudo apt-get update
sudo apt-get install ffmpeg
```

**Windows:**
Download from [ffmpeg.org](https://ffmpeg.org/download.html) or use chocolatey:
```bash
choco install ffmpeg
```

### Backend Setup

1. Navigate to the backend directory:
```bash
cd backend
```

2. Install dependencies:
```bash
npm install
```

3. Create a `.env` file:
```bash
touch .env
```

4. Edit `.env` and add your configuration:
```env
# Database configuration
DB_HOST=localhost
DB_PORT=5432
DB_NAME=readcast
DB_USER=postgres
DB_PASSWORD=your_password

# Or use a connection string instead:
# DATABASE_URL=postgresql://user:password@localhost:5432/readcast

# Authentication (required)
AUTH_USERNAME=admin
AUTH_PASSWORD=your_secure_password

# OpenAI API (required)
OPENAI_API_KEY=sk-proj-your_openai_key

# Server configuration
PORT=3001
FRONTEND_URL=http://localhost:5173
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

**Note:** Your browser will prompt for the username and password (AUTH_USERNAME and AUTH_PASSWORD) when accessing the API.

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
2. Choose content type:
   - **Article**: Enter a URL to save and extract content
   - **Text**: Paste plain text directly
3. Click "Save Content"

### Subscribing to Podcasts

1. Go to the **Feed** tab (left icon in bottom navigation)
2. Use the search bar to find podcasts by name
3. Click "Subscribe" on any podcast
4. View preview episodes and manually select which ones to add to your library
5. Click "Add to Library" on episodes you want to listen to

### Playing Content

1. Go to the **Library** tab (right icon in bottom navigation)
2. Click on any content item to open the player
3. Use playback controls:
   - Play/Pause
   - Skip forward/backward 15 seconds
   - Adjust playback speed (0.5x - 2x)
   - Set a sleep timer
4. For podcasts: Click "Generate Transcript" to transcribe the episode
5. Click on transcript/content words to seek to that position in the audio

### Managing Content

In the Library tab, you can:
- **Star** items to mark as favorite
- **Archive** items you've finished
- **Delete** items you no longer need
- **Generate Audio** for articles using the volume icon (automatically handles any article length)
- **Generate Transcript** for podcasts (automatically handles any episode length)

## Deployment

See [RAILWAY_DEPLOYMENT.md](RAILWAY_DEPLOYMENT.md) for complete instructions on deploying to Railway.app.

**Quick summary:**
1. Create Railway project with PostgreSQL database
2. Deploy backend service (root directory: `backend`)
3. Deploy frontend service (root directory: `frontend`)
4. Set environment variables for authentication and OpenAI API key
5. Railway automatically installs ffmpeg via the Dockerfile

Your app will be accessible from anywhere with HTTP Basic Auth protection!

## How It Works

### Article Audio Generation (Unlimited Length)
When you generate audio for an article:
1. Content is extracted from the URL using OpenAI to identify the main article text
2. Text is split into ~4KB chunks at sentence boundaries (OpenAI TTS has a 4096 char limit)
3. Each chunk is converted to audio using OpenAI TTS (gpt-4o-mini-tts)
4. Audio files are concatenated using ffmpeg into a single seamless MP3
5. User receives complete audio file regardless of article length

**Cost:** ~$0.015 per 1,000 characters (~$0.60 for a typical 40,000 character article)

### Podcast Transcription (Unlimited Length)
When you transcribe a podcast episode:
1. Audio is downloaded and streamed to disk (no memory limits)
2. If file > 25 MB (OpenAI Whisper limit):
   - Audio is split into 15-minute chunks using ffmpeg
   - Each chunk is compressed to mono, 64kbps, 16kHz (optimized for speech)
3. Each chunk is transcribed using OpenAI Whisper (gpt-4o-mini-transcribe)
4. Previous transcript is used as context (prompt parameter) for continuity
5. Transcripts are concatenated with adjusted word timestamps
6. User receives complete, accurate transcript

**Cost:** ~$0.006 per minute (~$1.08 for a 3-hour podcast)

## Roadmap

**Completed:**
- ✅ Unlimited article length TTS with audio concatenation
- ✅ Unlimited podcast length transcription with splitting/compression
- ✅ HTTP Basic Auth security
- ✅ Click-to-seek on transcript words
- ✅ Manual podcast episode selection

**Planned:**
- [ ] Chrome extension for one-click article saving
- [ ] Android app with share target support
- [ ] Better article parsing (current: OpenAI extraction, planned: Readability.js)
- [ ] YouTube video support (audio extraction + transcription)
- [ ] PDF support with text extraction
- [ ] Playlist/collection management
- [ ] Export functionality (transcripts, library data)
- [ ] Offline mode with service workers

## API Costs

Readcast uses OpenAI's API which charges based on usage:

| Feature | Model | Cost | Example |
|---------|-------|------|---------|
| Article TTS | gpt-4o-mini-tts | $0.015 / 1K chars | 40K char article = $0.60 |
| Podcast Transcription | gpt-4o-mini-transcribe | $0.006 / minute | 180 min podcast = $1.08 |

**Monthly estimate for typical usage:**
- 50 articles (~30K chars each): ~$22.50
- 20 podcast episodes (~60 min each): ~$7.20
- **Total: ~$30/month**

The free tier from OpenAI gives you $5 in credits to test the service.

## Troubleshooting

### "Cannot find ffprobe" or ffmpeg errors
- Ensure ffmpeg is installed: `ffmpeg -version`
- For Railway deployment: The Dockerfile automatically installs ffmpeg

### Transcription fails for large podcasts
- The app automatically handles files of any size
- Check Railway logs to ensure ffmpeg is installed
- Verify OpenAI API key is set correctly

### Audio generation seems truncated
- Modern implementation supports unlimited article length
- Check that you see "Generated complete audio in X parts" message
- Verify ffmpeg is available for audio concatenation

### HTTP 401 Unauthorized errors
- Check that AUTH_USERNAME and AUTH_PASSWORD are set in environment variables
- Your browser should prompt for credentials on first access
- For API access, use HTTP Basic Auth headers

### Database connection errors
- Verify PostgreSQL is running
- Check DATABASE_URL or individual DB_* environment variables
- For Railway: Ensure PostgreSQL service is linked to backend

## License

MIT

## Contributing

Contributions are welcome! Please feel free to submit a Pull Request.

## Support

For deployment help, see [RAILWAY_DEPLOYMENT.md](RAILWAY_DEPLOYMENT.md).

For issues or questions, please open an issue on GitHub.