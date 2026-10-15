# Private AI

ScreenTinker's AI features can run on **your own hardware**: an AI server on your own network
(Ollama, LM Studio, llama.cpp's server, vLLM, LocalAI, or anything else that speaks the OpenAI API).
Your prompts and sign text go only to that server. They do not go to a cloud AI provider, and on a
self-hosted ScreenTinker they never leave your building.

Schools, hospitals, councils and anyone else with data rules can use this. A cloud-only signage
product can't offer it.

With private AI you can:

- **Set up my screens with AI**: describe your place in one sentence and get a starter set of 3–6
  signs, built from the Make a sign designs and your brand kit.
- **Translate** a sign or slide deck into other languages, check every line, then pick a language
  for each screen or have the screen rotate through them.
- Use the existing AI tools (Slides **Generate**, the Designer's **AI generate**) with the same server.

When no AI server is set up, these features are hidden or show a short explanation. They never
show an error.

---

## For everyone

### The badge

When the workspace's AI is a local server on a private network address, AI screens show a green
**🔒 Private: data stays on your network** badge. You'll see it in AI settings, the Slides AI bar,
the Designer, Set up with AI and Translate.

ScreenTinker shows the badge only when this is true: the provider is "Local / private" and its
address resolved **only** to private-network addresses (loopback, 10/8, 172.16/12, 192.168/16,
100.64/10, IPv6 unique-local) when it was saved. A "local" server on a public address doesn't get
the badge.

### Set up my screens with AI

**Simple view:** on the home page, tap **Set up my screens with AI**. This task only appears when AI
is set up. **Advanced view:** go to **Slides → Set up with AI**.

1. Write one sentence about your place, for example *"A small bakery in Leeds, open 7–5, we sell
   sourdough and pastries"*. Then choose landscape or portrait.
2. Tap **Suggest signs**. A local model can take a minute or two.
3. **Pick the signs you want.** Each card is a live preview with your brand kit applied.
4. **Check each sign.** Each one opens in Make a sign's normal fill-in step. Change any word, or
   tap **Leave this one out** to skip it.
5. **Choose screens.** All the signs you kept go onto the chosen screens in one publish. If your
   workspace reviews changes, you get one review, not one per sign.

The AI fills in only the words on a template. It never writes layout or HTML. ScreenTinker checks
every value against the template's field rules: text and line limits, list sizes, and which fields
it may fill. Anything that fails is dropped. The template's own validator then checks the sign
again, just as it checks a sign you typed yourself.

The AI is never asked for facts it can't know. It doesn't get the Wi-Fi, QR code, countdown or
celebration designs, and it can't fill links, colours or switches. It's told not to make up phone
numbers, prices, dates or names. If your brand kit has a business name, ScreenTinker uses that
instead of what the AI wrote. Any field the AI leaves out starts empty, not with sample text.

### Translate

**Slides → Translate** (`#/translate`):

1. Next to a sign or deck, click **Translate** and choose languages. The list has common languages,
   or you can type a code such as `pt-BR`.
2. Check every translated line next to its original and fix anything that's wrong.
   - **Kept in the original**: the AI lost a placeholder, so this line stayed in the original
     language. Translate it by hand.
   - **Check the numbers** or **Check the line breaks**: the translation changed a number or the
     number of lines.
3. Click **Approve and use on screens**. Nothing reaches a screen before you approve it. If you
   edit a translation later, it goes back to *needs review*. Screens keep the last approved words
   until you approve it again.
4. Under **Language on each screen**, choose one of these for each screen:
   - **Original**: the default.
   - **A language**: translated signs show in that language. Anything without a translation plays
     as it is.
   - **Rotate**: each translated sign is followed by its translations, so the languages alternate
     item by item.

These are never translated: `{{ds:…}}` data-source values, `{name}`-style placeholders, `%s`, links
and email addresses. ScreenTinker hides them from the AI before it sends any text. A translation is
accepted only if every one comes back exactly once. Prices and other text without letters are
never sent. QR codes, lettering artwork, colours and layout are copied as they are. Only the words
change.

If you translate a deck before it's published, screens can't show it yet. Publish the deck (or put
the sign on a screen), then approve the translation again.

Translation works with a local server or a cloud provider. It uses whichever one the workspace has
set up.

---

## For admins

### Setting up a local AI server

Open **AI settings**: the ⚙ next to *Generate* in Slides, or next to *AI generate* in the Designer.
Then:

1. Under **Where should AI run?**, choose **Local / private**.
2. Enter the **AI server address**, for example `http://ollama.lan:11434/v1`. Add an **API key**
   only if your server needs one.
3. Click **Test & list models**. ScreenTinker asks the server for `GET /v1/models`. If that fails, it
   tries Ollama's own `GET /api/tags`.
4. Choose a **text model**. If the server can make images (for example LocalAI with Stable Diffusion),
   you can also choose an **image model**.
5. Click **Save**.

Settings are per workspace, like the bring-your-own AI settings. Workspace admins can change them.
API keys are encrypted at rest and never sent back to the browser.

If you switch from a cloud provider to a local one without typing a new key, ScreenTinker drops the
saved key. Your OpenAI key is never sent to a machine on your LAN.

#### Ollama, step by step

1. Install Ollama on a machine on your network: `curl -fsSL https://ollama.com/install.sh | sh`
   (Linux), or use the installer for macOS or Windows.
2. Download a model: `ollama pull llama3.1:8b`. On smaller hardware, use `ollama pull llama3.2:3b`.
3. Make Ollama listen on the network, not only on its own machine. Set `OLLAMA_HOST=0.0.0.0`. On
   Linux, add it to a systemd drop-in for `ollama.service`, then restart Ollama.
4. In ScreenTinker, use the address `http://<that-machine>:11434/v1` and leave the key blank.

#### LM Studio, step by step

1. Install LM Studio and download a model from its **Discover** tab (for example a Llama 3.1 8B
   Instruct or Qwen 2.5 7B Instruct GGUF).
2. Open the **Developer** tab, load the model and start the server. Turn on **Serve on local network**
   so other machines can reach it.
3. In ScreenTinker, use the address `http://<that-machine>:1234/v1` and leave the key blank.

llama.cpp (`llama-server --host 0.0.0.0 --port 8080`), vLLM (`vllm serve <model>`) and LocalAI work
the same way. Use their `/v1` address.

### Allowing a private address

ScreenTinker protects its own network: by default it won't connect to private, loopback or
link-local addresses that someone typed in (see [outbound-requests.md](outbound-requests.md)). So
what you need to do depends on how your instance runs:

| Instance | What happens with a LAN address |
|---|---|
| Self-hosted, `SELF_HOSTED=true` | Allowed. Self-hosted mode has always let AI endpoints use the LAN ([local-ai-setup.md](local-ai-setup.md)). |
| Any instance with `OUTBOUND_ALLOW_HOSTS` naming the host | Allowed for every feature, under the normal outbound rules. |
| Otherwise | **Refused until it's allowed.** Nothing connects to the address first. |

When an address is refused, **Test & list models** tells you which host it is and that it's on a
private network. It also tells you exactly what would allow it:

- **Allow `<host>` for AI** (only shown to platform administrators). This allows **that one host**
  (exact name or single IP), **for this organization's AI requests only**. It doesn't open a range,
  it doesn't change anything for other organizations, and it doesn't affect other features.
  Cloud-metadata addresses are always refused. Platform admins can remove the allowance with
  `DELETE /api/ai/private/allow-host/<host>`.
- **Or** set `OUTBOUND_ALLOW_HOSTS=<host>` in the server environment and restart. This allows the
  host for every feature that fetches a URL.

This feature never sets or suggests `OUTBOUND_ALLOW_PRIVATE`, which opens every private range at
once.

### Only allow private AI

Organization owners and admins can turn on **Only allow private AI in this organization** in AI
settings. While it's on:

- Saving or listing models for a non-private endpoint in AI settings is refused.
- Every AI request first checks again that the server's address is private. If a name now points
  somewhere else, the request is refused before anything is sent.
- **ScreenTinker-hosted images** (credits) are hidden. `/api/ai/hosted/status` returns
  `enabled: false, reason: private_only`, and `/generate` is refused. Credits are never reserved.
- In the settings dialog, the **Cloud or your own endpoint** option is turned off.

### Credits and plans

Local AI never uses ScreenTinker credits. Hosted images keep working exactly as described in
[ai-credits.md](ai-credits.md), unless **Only allow private AI** is on.

### What is sent where

| Feature | Sent to your AI server | Never sent |
|---|---|---|
| Test & list models | `GET /v1/models` (or `/api/tags`), with your key if you set one | anything else |
| Set up with AI | the system prompt (template names and field limits), your sentence | your brand kit, screens, other content |
| Translate | the sign's words with placeholders replaced by `[[1]]`-style markers, and the target language | layout, links, data-source values, prices, QR payloads, other decks |
| Slides / Designer generate | your prompt (unchanged from before) | |

ScreenTinker itself stores the translated text (`sign_translations`) and the signs you create (ordinary
decks and widgets). Neither ScreenTinker's activity log nor its server log ever contains the
sentence, a prompt or any sign text. The audit log records only actions, ids, counts, the host name
and the model name: `ai:private_settings`, `ai:private_host_allow`, `ai:policy`, `ai:starter_set`,
`ai:translate`, `ai:translation_approve`, `ai:screen_language`, …

### Hardware notes

- **Small models are enough.** Starter sets and translation use short, strict JSON prompts. A 3B
  model (Llama 3.2 3B, Qwen 2.5 3B) works. A 7–8B model (Llama 3.1 8B, Qwen 2.5 7B, Mistral 7B) gives
  noticeably better translation. ScreenTinker retries once with the exact problems named, and drops
  anything that's still invalid.
- **Memory:** a 4-bit 3B model needs about 3 GB of RAM or VRAM, and a 7–8B model about 5–6 GB.
  Leave room for the context window.
- **CPU only works, slowly.** A starter set on a modern 8-core CPU with an 8B model takes about
  30–90 seconds. With a GPU (NVIDIA, AMD, or Apple Silicon) it takes a few seconds. Requests time out
  after 3 minutes.
- **Reasoning models** (Qwen3, DeepSeek-R1) work. ScreenTinker ignores their `<think>` block.
- **Images** need a separate image model and far more VRAM (SDXL is about 8 GB). See
  [local-ai-setup.md](local-ai-setup.md).

### Permissions

| Action | Who |
|---|---|
| See whether AI is set up, and the badge | every workspace member |
| Set up the local AI server | workspace admins |
| Allow a private host | platform administrators |
| Only allow private AI | organization owners and admins |
| Set up with AI, translate, edit, approve, choose screen languages | workspace editors and admins (view-only members are refused) |
| Approve a translation in a workspace that reviews changes | reviewers and admins |

### API (dashboard session only)

| Method & path | Purpose |
|---|---|
| `GET /api/ai/private/status` | `{configured, kind, private, only_private, can_*}` (admins also get `base_url`, `allowed_hosts`) |
| `POST /api/ai/private/test` | `{base_url, api_key?}` → where the host lives, whether it's allowed (or how to allow it), and the models |
| `PUT /api/ai/private/settings` | `{base_url, model, api_key?, image_model?, clear_key?, clear_image?}` |
| `POST`/`DELETE /api/ai/private/allow-host[/:host]` | platform admin: allow or remove one host for this organization |
| `PUT /api/ai/private/policy` | `{only_private}`, org owner or admin |
| `POST /api/ai/private/starter` | `{description}` → `{proposals: [{template, values, dropped}]}` |
| `POST /api/ai/private/translate` | `{deck_id, langs[]}` → draft translations |
| `GET /api/ai/private/translations[?deck_id]` | list (with strings when `deck_id` is given) |
| `PUT /api/ai/private/translations/:id` | `{strings: [{slide_id, slot, text}]}`. Refused if a placeholder is lost. Sets the translation back to draft |
| `POST /api/ai/private/translations/:id/approve` · `DELETE …/:id` | approve (builds the language's slide widgets) or delete |
| `GET /api/ai/private/screens` · `PUT /api/ai/private/screens/:deviceId` | `{mode: original\|fixed\|rotate, langs[]}` |

Rate limits: `test` 20 per minute, `starter` 6 per minute, `translate` 4 per minute.

### How a screen gets its language

The player protocol doesn't change. When a screen's playlist is sent, any slide that has an approved
translation in the screen's language is replaced by that translation's slide widget. In **Rotate**,
the original is followed by its translations. This only applies to the screen's own playlist.
Head-office (corporate), emergency, CAP and automation playlists always play as published. If
anything goes wrong, the screen plays the playlist exactly as published.

### Database

These changes add to the schema and don't alter anything that's already there:

- `ai_settings.provider_kind` and `ai_settings.endpoint_private`
- `ai_private_hosts`: one allowed host per row, per organization
- `org_ai_policy`: the "only allow private AI" setting
- `sign_translations`: a translated deck document, its review notes, and its widget map
- `device_languages`: each screen's language mode
