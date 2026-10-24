# pi-discord-dms

Text one pi session from one Discord DM. Pi's replies come back as ordinary messages. A live
status line shows how many tools it has called and which one ran last. Pi can also send you
files. From any other channel, `/yo` and the **Send to pi** message action pass things to pi,
and pi's answer can be posted back there.

## Setup

1. **Create a bot.** Go to <https://discord.com/developers/applications>, choose New Application,
   open Bot, choose Reset Token and copy the token. You don't need any privileged intents.
2. **Let the bot DM you.** The bot can only DM you if you share a server with it. Under OAuth2 →
   URL Generator, tick `bot`, open the generated URL and add the bot to any server you're in. A
   private server of your own works.

   To use `/yo` and **Send to pi** in servers the bot isn't in, open Installation, tick
   **User Install** under Installation Contexts and save. Then open the Discord Provided Link
   and choose **Add to My Apps**.
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
| Discord | a reply | Pi gets up to 300 characters of the message you replied to as context |
| Discord | `!stop` | Abort the current run |
| Discord | `./command args` | Run a pi slash command. See below |
| Discord | attachments | Saved under `~/.pi/agent/discord-dms/inbox/`. Pi gets the file paths, and images are also sent inline |
| any channel | `/yo` | Opens a form for a message and files. Pi gets them with a link to the channel, and its answer can be posted there |
| any channel | message → Apps → **Send to pi** | Opens a form for an optional note and files. Pi gets the message's text, attachments and link, and its answer can be posted there as a reply |

Pi rejects new prompts while a manual compaction or branch summary is running. Messages you send
during one wait and go through once it finishes, as they do when typed in the TUI.

### Sending from other channels

`/yo` and **Send to pi** work in servers, group DMs and other DMs. Only you can see the
"Sent to pi" confirmation, and pi's reply comes to the bot's DM like any other. Pi gets the
server and channel IDs and a link to where you sent it from. If pi can read that server some
other way, such as through another bot, it's told to check before saying it can't. Note in
AGENTS.md which access goes with which server ID, and how to use it.

When pi finishes, "Sent to pi" turns into a preview of its final answer with a **Post** button.
Post sends the answer to the channel, with any files it embeds. After **Send to
pi** it shows as a reply to the message you shared. After `/yo` it replies to the "Sent to pi"
message, which others see as "Original message was deleted". Nobody gets pinged.

Tick **Post the answer here automatically** in the form to skip the preview. Before posting, a
Jev classifier checks that the answer doesn't look private, using the first of the classifiers
[pi-safety](https://github.com/KTibow/pi-safety) tries that has credentials. If it rates the
answer 30% or more likely to be private, or no classifier is available, you get the preview
instead. Answers that embed local files, and runs that end in an error or `!stop`, always get the
preview, since the classifier only reads text.

Discord only lets the bot update "Sent to pi" for 15 minutes after you send something. If pi
takes longer, there's no preview: the DM says it was too late, and you can forward pi's reply
yourself. A preview you got in time can still be posted later. Servers can deny Use External Apps
to stop apps they haven't installed from posting publicly. Where it's denied for you, the form
doesn't offer posting and "Sent to pi" says so.

The bot registers both commands when it connects. Without User Install they only work in
servers the bot is in, and `/discord status` says so. New commands can take a minute to appear,
or a Discord restart.

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
- Tool calls are listed in one status message, which arrives silently. Commands read like a
  shell prompt, so `cd dir && make` shows as `dir $ make`. Failed calls show their exit code and
  last line of output, and running ones show how long they've been going. The latest call also
  shows its last lines of output, its diff or the start of the file it wrote. The latest image pi
  read appears beside its line. Between tool calls, one more line shows what pi is thinking or
  which tool call it's writing, and it goes away once pi acts. After pi posts text, the next tool
  call moves the status message below it. It shows `✓` when the run ends.
- A reply that is empty or exactly `[silent]` is not posted. Errors and aborts are posted.
- The bridge **disarms** when the agent settles, meaning no retries, compactions or queued
  messages remain. It also disarms when a user message that didn't come from Discord enters the
  transcript, such as something you type or queue in the TUI. From then on the output stays
  local.
- Runs that another extension started post their assistant text too, unless it's `[silent]`.
  That covers custom messages and user messages sent with `sendUserMessage`, such as a
  heartbeat. It also covers the agent continuing on its own. Only something you type or queue
  in the TUI, or send over RPC, counts as a local run. The
  agent spoke instead of staying silent, so it probably has something to tell you. These runs
  show no tool status, since their tool calls may not lead anywhere.
- The typing indicator shows whenever pi is working, whoever started the run. It never sends a
  notification.
- Messages from other extensions never switch Discord posting on or off.

### Files in replies

Pi sends a file by embedding it in a reply with Markdown image syntax and a local path or `https`
URL: `![chart](./chart.png)`. The file shows where pi wrote it, in the same message as the text.
Images and videos appear inline, and other files, such as PDFs, appear as a download card. Each
can be up to 10 MB. Plain links, paths and anything in code stay text, so a file is only sent when
pi embeds it. Embeds that point at a missing file, or at a URL that isn't an image or video, are
left as written.

These replies use Discord's newer message layout (components v2). If Discord rejects one, the
files are attached below the text instead. Pi's Discord instructions, including this one, are
added to its system prompt only while the session is connected.

## Development

```bash
git clone https://github.com/KTibow/pi-discord-dms && cd pi-discord-dms
npm install
pi install .
```

Pi doesn't install dependencies for local paths, which is why `npm install` comes first.
`pi install .` saves the path in `~/.pi/agent/settings.json`, and `/reload` picks up edits.
