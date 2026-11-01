import { getPlayer } from './player_api/helpers';

const ENDPOINT = 'http://127.0.0.1:18999/log';
const FLUSH_MS = 2000;
const RETRY_MS = 30000;
const SCREEN_CHECK_MS = 5000;
const MAX_LINE_CHARS = 4000;
const MAX_BATCH_LINES = 200;
const MAX_BUFFERED_LINES = 5000;
const MAX_DEPTH = 3;
const MAX_KEYS = 40;
const ERROR_SCREEN_TEXT = 'Something went wrong';
const MEDIA_EVENTS = [
  'abort',
  'canplay',
  'emptied',
  'ended',
  'error',
  'loadstart',
  'pause',
  'playing',
  'stalled',
  'waiting'
];
const CONSOLE_LEVELS = ['debug', 'log', 'info', 'warn', 'error'] as const;

interface DebugPlayer {
  addEventListener(type: string, listener: (value: unknown) => void): void;
  getPlayerState?(): number;
  getVideoData?(): unknown;
  getVideoStats?(): unknown;
  getPlayerResponse?(): { playabilityStatus?: unknown } | undefined;
  getDebugText?(full: boolean): string;
}

interface RequestMeta {
  method: string;
  url: string;
  started: number;
}

interface PlayerResponseLike {
  playabilityStatus?: { status?: string };
  videoDetails?: { videoId?: string };
  streamingData?: { adaptiveFormats?: unknown[] };
}

// Hooks of other modules run later and change what these return, so keep the originals.
const originalFetch = window.fetch.bind(window);
const originalStringify = JSON.stringify;
const originalParse = JSON.parse;
const originalConsole = {
  debug: console.debug,
  log: console.log,
  info: console.info,
  warn: console.warn,
  error: console.error
};

let buffer: string[] = [];
let dropped = 0;
let sending = false;
let nextSendAt = 0;
let debugPlayer: DebugPlayer | null = null;

function brief(value: unknown, depth = 0): unknown {
  if (value instanceof Error) return `${value.name}: ${value.message}`;
  if (typeof value === 'function') return '[function]';
  if (typeof value !== 'object' || value === null) return value;
  if (value instanceof Node) return `[${value.nodeName}]`;
  if (depth >= MAX_DEPTH) return '[object]';
  if (Array.isArray(value)) {
    return value.slice(0, MAX_KEYS).map((item) => brief(item, depth + 1));
  }

  const result: Record<string, unknown> = {};
  for (const key of Object.keys(value).slice(0, MAX_KEYS)) {
    try {
      result[key] = brief((value as Record<string, unknown>)[key], depth + 1);
    } catch {
      result[key] = '[throws]';
    }
  }
  return result;
}

function show(value: unknown): string {
  if (typeof value === 'string') return value;
  try {
    return originalStringify(brief(value)) ?? String(value);
  } catch {
    return '[unprintable]';
  }
}

function write(level: string, ...parts: unknown[]) {
  try {
    const text = parts.map(show).join(' ').slice(0, MAX_LINE_CHARS);
    const line = `${new Date().toISOString()} ${level} ${text.replace(/\n/g, '\\n')}\n`;
    buffer.push(line);
    if (buffer.length > MAX_BUFFERED_LINES) {
      buffer.shift();
      dropped++;
    }
  } catch {
    // Logging must never break the app.
  }
}

function takeBatch(): string {
  const batch = buffer.slice(0, MAX_BATCH_LINES);
  buffer = buffer.slice(batch.length);
  if (dropped > 0) {
    batch.unshift(
      `${new Date().toISOString()} LOG dropped ${dropped} old lines\n`
    );
    dropped = 0;
  }
  return batch.join('');
}

function flush() {
  if (sending || buffer.length === 0 || Date.now() < nextSendAt) return;

  sending = true;
  const lines = buffer.slice(0, MAX_BATCH_LINES);
  const body = takeBatch();
  originalFetch(ENDPOINT, { method: 'POST', body })
    .catch(() => {
      buffer = lines.concat(buffer);
      nextSendAt = Date.now() + RETRY_MS;
    })
    .then(() => {
      sending = false;
    });
}

function withoutQuery(url: string): string {
  return url.split('?')[0] ?? url;
}

function isPlayerRequest(url: string): boolean {
  return url.includes('/youtubei/v1/player');
}

function logRequest(meta: RequestMeta, status: number, failure?: string) {
  const failed = failure !== undefined || status === 0 || status >= 400;
  if (!failed && !isPlayerRequest(meta.url)) return;

  write(
    failed ? 'NET-FAIL' : 'NET',
    meta.method,
    withoutQuery(meta.url),
    `status=${status}`,
    `ms=${Date.now() - meta.started}`,
    failure ?? ''
  );
}

function hookConsole() {
  for (const level of CONSOLE_LEVELS) {
    const original = originalConsole[level];
    console[level] = function (...args: unknown[]) {
      write(`CONSOLE-${level.toUpperCase()}`, ...args);
      original.apply(console, args);
    };
  }
}

function hookFetch() {
  window.fetch = function (input: RequestInfo | URL, init?: RequestInit) {
    const meta: RequestMeta = {
      method: init?.method ?? (input instanceof Request ? input.method : 'GET'),
      url: input instanceof Request ? input.url : String(input),
      started: Date.now()
    };
    return originalFetch(input, init).then(
      (response) => {
        logRequest(meta, response.status);
        return response;
      },
      (error: unknown) => {
        logRequest(meta, 0, show(error));
        throw error;
      }
    );
  };
}

function hookXhr() {
  const metas = new WeakMap<XMLHttpRequest, RequestMeta>();
  const originalOpen = XMLHttpRequest.prototype.open as (
    this: XMLHttpRequest,
    ...args: unknown[]
  ) => void;
  const originalSend = XMLHttpRequest.prototype.send;

  XMLHttpRequest.prototype.open = function (
    this: XMLHttpRequest,
    ...args: unknown[]
  ) {
    metas.set(this, {
      method: String(args[0]),
      url: String(args[1]),
      started: Date.now()
    });
    originalOpen.apply(this, args);
  };

  XMLHttpRequest.prototype.send = function (body) {
    const meta = metas.get(this);
    if (meta) {
      meta.started = Date.now();
      this.addEventListener('loadend', () => logRequest(meta, this.status));
    }
    originalSend.call(this, body);
  };
}

function hookJsonParse() {
  // The player answers reach the page by several ways, all of them go through here.
  JSON.parse = function (...args: Parameters<typeof JSON.parse>) {
    const result = originalParse.apply(JSON, args) as PlayerResponseLike | null;
    try {
      const status = result?.playabilityStatus;
      if (status) {
        write(
          status.status === 'OK' ? 'PLAYER' : 'PLAYER-FAIL',
          'video',
          result?.videoDetails?.videoId ?? '?',
          'formats',
          result?.streamingData?.adaptiveFormats?.length ?? 0,
          status
        );
      }
    } catch {
      // Logging must never break the app.
    }
    return result;
  };
}

function videoState() {
  const video = document.querySelector('video');
  if (!video) return null;
  return {
    src: withoutQuery(video.currentSrc).slice(0, 80),
    readyState: video.readyState,
    networkState: video.networkState,
    time: video.currentTime,
    paused: video.paused,
    errorCode: video.error?.code,
    errorMessage: video.error?.message
  };
}

function snapshot(reason: string) {
  write('SNAPSHOT', reason, 'hash', location.hash);
  write('SNAPSHOT', 'video', videoState());
  write('SNAPSHOT', 'online', navigator.onLine, 'visible', !document.hidden);
  const player = debugPlayer;
  if (!player) return;

  const reads: [string, () => unknown][] = [
    ['state', () => player.getPlayerState?.()],
    ['playability', () => player.getPlayerResponse?.()?.playabilityStatus],
    ['videoData', () => player.getVideoData?.()],
    ['videoStats', () => player.getVideoStats?.()],
    ['debugText', () => player.getDebugText?.(true)]
  ];
  for (const [name, read] of reads) {
    try {
      write('SNAPSHOT', name, read());
    } catch (error) {
      write('SNAPSHOT', name, 'failed', error);
    }
  }
}

function watchMediaEvents() {
  for (const name of MEDIA_EVENTS) {
    document.addEventListener(
      name,
      (event) => {
        if (event.target instanceof HTMLMediaElement) {
          write(`MEDIA-${name.toUpperCase()}`, videoState());
        }
      },
      true
    );
  }
}

function watchPageEvents() {
  window.addEventListener(
    'error',
    (event) => {
      if (event.target instanceof HTMLMediaElement) return;
      write(
        'PAGE-ERROR',
        event.message,
        event.filename,
        event.lineno,
        event.error ?? ''
      );
    },
    true
  );
  window.addEventListener('unhandledrejection', (event) => {
    write('PAGE-REJECTION', event.reason);
  });
  window.addEventListener('online', () => write('PAGE', 'online'));
  window.addEventListener('offline', () => write('PAGE', 'offline'));
  window.addEventListener('hashchange', () => {
    write('PAGE', 'hash', location.hash);
  });
  document.addEventListener('visibilitychange', () => {
    write('PAGE', 'visible', !document.hidden);
  });
  window.addEventListener('pagehide', () => {
    write('PAGE', 'hide');
    navigator.sendBeacon(ENDPOINT, takeBatch());
  });
}

function watchErrorScreen() {
  let shown = false;
  setInterval(() => {
    const now =
      document.body?.textContent?.includes(ERROR_SCREEN_TEXT) ?? false;
    if (now && !shown) snapshot('error screen shown');
    if (!now && shown) write('PAGE', 'error screen gone');
    shown = now;
  }, SCREEN_CHECK_MS);
}

async function watchPlayer() {
  const player = (await getPlayer()) as unknown as DebugPlayer;
  debugPlayer = player;
  write('PLAYER', 'found');
  player.addEventListener('onStateChange', (state) => {
    write('PLAYER-STATE', state, videoState());
  });
  player.addEventListener('onError', (code) => {
    write('PLAYER-ERROR', code);
    snapshot(`player error ${show(code)}`);
  });
}

hookConsole();
hookFetch();
hookXhr();
hookJsonParse();
watchMediaEvents();
watchPageEvents();
watchErrorScreen();
setInterval(flush, FLUSH_MS);
write('START', __YTAF_VERSION__, navigator.userAgent, location.href);
void watchPlayer().catch((error: unknown) => {
  write('LOG', 'player watch failed', error);
});
