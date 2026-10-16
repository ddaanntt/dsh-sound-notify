# dsh-sound-notify

A notification chime for **DeepSeek Harness** that only fires when you are *not* already looking.

Most "play a sound when the agent finishes" plugins beep unconditionally. This one asks the
browser what you are actually doing, and stays quiet when the answer is "watching this session".

| Moment | Sound |
|---|---|
| A session finished its turn and waits for your next message | soft notification chime |
| A tool call needs your **approval** | alert chime |
| A structured question needs your **answer** (`ask_user_question`) | alert chime |

Silent when: the window is focused and visible **and** the session in question is one of the
conversations it is displaying.

## Install

```sh
# straight from GitHub
dsh plugin --profile <your-profile> add github:ddaanntt/dsh-sound-notify

# from npm (once published there)
dsh plugin --profile <your-profile> add dsh-sound-notify

# from a tarball or a local checkout
dsh plugin --profile <your-profile> add ./dsh-sound-notify-0.1.0.tgz
dsh plugin --profile <your-profile> add ./dsh-sound-notify
```

This package ships plain JavaScript and declares **no install scripts**, so pnpm runs no build
step and no `allowBuilds` authorization is required — unlike a TypeScript plugin installed from
git, which needs a `prepare` script plus your explicit approval to run it.

If `git` cannot reach github.com from your network, the fetch fails before pnpm ever sees the
package; point git at your proxy first (for example
`git config --global http.proxy http://127.0.0.1:7897`), or install the tarball instead.

Then **reload the browser page once**. The client half is delivered through the boot manifest,
which is injected when the page is served — an already-open tab keeps running the old manifest
until it reloads.

Verify the layer composed:

```sh
dsh --profile <your-profile> --dump-config   # look for the "# == dsh-sound-notify" layer
```

## Configuration

Override any of these in your profile's `cordis.patch.yml` (a patch replaces the whole `config`
value, so restate the keys you keep):

```yaml
- id: sound-notify
  config:
    onTurnEnd: true
    onUserInputNeeded: true
    startupChime: false
    turnEndSound: 'C:\Windows\Media\Windows Notify System Generic.wav'
    attentionSound: 'C:\Windows\Media\chimes.wav'
    minIntervalMs: 700
    suppressTurnEndAfterAttentionMs: 5000
    presenceTtlMs: 20000
    debugLog: ''
```

| Key | Default | Meaning |
|---|---|---|
| `onTurnEnd` | `true` | Chime when a top-level session goes idle |
| `onUserInputNeeded` | `true` | Chime on approval requests and structured questions |
| `startupChime` | `false` | Also chime when the plugin mounts (handy to confirm it works) |
| `turnEndSound` | Windows "Notify System Generic" | WAV/audio file path |
| `attentionSound` | Windows `chimes.wav` | WAV/audio file path |
| `minIntervalMs` | `700` | Same-sound anti-flutter window |
| `suppressTurnEndAfterAttentionMs` | `5000` | Don't add a turn-end chime right after asking you something |
| `presenceTtlMs` | `20000` | A browser report older than this is ignored |
| `debugLog` | `''` | File path; append one line per decision, including why a chime was skipped |

Any sound file the OS player can open works. On Windows the defaults come from
`%WINDIR%\Media`; on macOS `afplay` is used and on Linux `paplay`/`aplay`, with a terminal bell
as the last resort. A missing file falls back to a short beep rather than staying silent.

## How the "are you looking at it" decision works

The host cannot know what your browser is showing, so the browser tells it.

- **Which conversations are open** — the client half registers an invisible probe in the
  session-scoped `conversation.input.dock` slot. The probe mounts with the session's
  conversation and unmounts when you switch away, so the client always knows the open set.
- **Whether you are there** — `document.visibilityState` plus `focus`/`blur`, re-announced on
  every change and on a 5-second heartbeat.
- Reports go to `POST /sound-notify/presence`, keyed per browser window, so two windows never
  overwrite each other.

The host chimes unless some live client reports *focused + visible + this session in its open
set*. Design consequences worth knowing:

- **Stale means absent.** A closed, frozen, or minimized-forever tab stops reporting and is
  ignored after `presenceTtlMs`, so a dead client can never silence notifications permanently.
- **No report at all means chime.** Before any browser has ever reported, every chime fires.
- **Delegated subagents are always silent.** A subagent run is a published child
  (`subagent/start`), not a conversation you are watching — and its approvals are auto-rejected,
  not answered by a human.
- **Multiple open conversations count as "looking".** If a session is open anywhere in the UI,
  a chime for it is suppressed while that window is focused.

Inspect the live state at any time:

```
http://127.0.0.1:19387/sound-notify/presence
```

It returns each reporting client's age, focus/visibility, and open session ids.

## Requirements

- A profile with a Web surface (`web` / `desktop`). The chime logic itself has no hard service
  dependency — without a webserver the plugin still chimes, it just cannot see the browser.
- Tested against DSH `0.2.0-rc.2`.

## Troubleshooting

Nothing is ever silent when you are away — check `debugLog`, then
`/sound-notify/presence`. If it reports `visible: false` while you are looking at the window,
your GUI is probably running in a different client (e.g. a browser tab) than the one reporting;
reload that page so it picks up the client half.

## License

MIT
