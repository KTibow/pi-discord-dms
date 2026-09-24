# pi-discord-dms

Text one pi session from one Discord DM. Pi's replies come back as ordinary messages. A live
status line shows how many tools it has called and which one ran last. Pi can also send you
files.

## Setup

1. **Create a bot.** Go to <https://discord.com/developers/applications>, choose New Application,
   open Bot, choose Reset Token and copy the token. You don't need any privileged intents.
2. **Let the bot DM you.** The bot can only DM you if you share a server with it. Under OAuth2 →
   URL Generator, tick `bot`, open the generated URL and add the bot to any server you're in. A
   private server of your own works.
3. **Get your user ID.** In Discord, turn on Settings → Advanced → Developer Mode, then
   right-click your name and choose Copy User ID.
4. **Install:**

   ```bash
   pi install git:github.com/KTibow/pi-discord-dms
   ```

   Pi clones the repo and installs its dependencies. To try it for one run without installing,
   use `pi -e git:github.com/KTibow/pi-discord-dms --discord`.

5. **Connect.** In the pi session you want to text, run `/discord setup`. It asks for the token
   and your user ID, saves them to `~/.pi/agent/discord-dms/config.json` (mode 600) and connects.

To keep the credentials out of that file, set `PI_DISCORD_BOT_TOKEN` and `PI_DISCORD_USER_ID`
instead. The environment variables take priority over the file.

## Usage

| Where | What | Effect |
|---|---|---|
| pi | `/discord` | Connect this session and remember it, so resuming the session reconnects |
| pi | `/discord off` | Disconnect and forget |
| pi | `/discord status` | Show whether this session is connected |
| shell | `pi --discord` | Start connected |
| Discord | any message | Sent to pi. Starts a run when pi is idle and steers the run when pi is busy |
| Discord | `!stop` | Abort the current run |
| Discord | `./command args` | Run a pi slash command. See below |
| Discord | attachments | Saved under `~/.pi/agent/discord-dms/inbox/`. Pi gets the file paths, and images are also sent inline |

### Slash commands from Discord

Discord takes over messages that start with `/`, so type `./` instead: `./compact`, `./model sonnet`.

- **Extension commands** run as if typed in the TUI. Their output shows in the TUI, and Discord gets a ✅.
- **Prompt templates and skills** (`./review`, `./skill:name`) expand into a prompt, and the reply
  comes back to Discord.
- **Built-ins that work from Discord:** `./help`, `./stop`, `./compact [instructions]`,
  `./model [search]`, `./thinking [level]`, `./name [name]`, `./session`, `./new` and `./reload`.
  Without arguments, `./model`, `./thinking` and `./name` show the current value.
- **TUI-only built-ins:** the rest open pickers or dialogs, such as `/tree`, `/settings` and
  `/resume`.

### Only one session owns the DM

The extension is installed for every pi session but does nothing until you run `/discord`. The
owning process writes its PID to `~/.pi/agent/discord-dms/lock.json`. If you run `/discord` in
another pi, it asks whether to take over, and the old session disconnects within about a second.
The connection stays with the owning process through `/reload`, `/new` and `/resume`.

### What gets posted

Messages from Discord reach pi prefixed with `[discord]`. Seeing one of these in the transcript
**arms** the bridge:

- While armed, each assistant message's text is posted to the DM. That includes the short
  comments pi writes between tool calls, just as the TUI shows them.
- Each tool call updates one status line, for example `🔧 4 tool calls · latest: bash 'npm test'`.
  After pi posts text, the next tool call moves the status line below it. It shows `✓` when the
  run ends.
- A reply that is empty or exactly `[silent]` is not posted. Errors and aborts are posted.
- The bridge **disarms** when the agent settles, meaning no retries, compactions or queued
  messages remain. It also disarms when a user message that didn't come from Discord enters the
  transcript, such as something you type or queue in the TUI. From then on the output stays
  local.
- Runs that no user message started post their assistant text too, unless it's `[silent]`. That
  covers another extension's message waking the agent, or the agent continuing on its own. The
  agent spoke instead of staying silent, so it probably has something to tell you. These runs
  show no tool status, since their tool calls may not lead anywhere.
- The typing indicator shows whenever pi is working, whoever started the run. It never sends a
  notification.
- Custom messages from other extensions don't change the armed state.

Pi sends files with the `discord_send_files` tool (`paths`, optional `caption`, 10 MB per file).
The tool is active only while the session is connected. Ordinary replies don't need a tool.

## Development

```bash
git clone https://github.com/KTibow/pi-discord-dms && cd pi-discord-dms
npm install
pi install .
```

Pi doesn't install dependencies for local paths, which is why `npm install` comes first.
`pi install .` saves the path in `~/.pi/agent/settings.json`, and `/reload` picks up edits.
