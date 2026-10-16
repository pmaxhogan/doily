# Sci-Net flow capture (2026-10-16, logged in)

Observed in the owner's browser while logged in. Usernames are redacted.
Everything here corrects the guesses in `src/scinet/site.ts`.

## URL map

| Path                               | Method      | What it is                                                            |
| ---------------------------------- | ----------- | --------------------------------------------------------------------- |
| `/`                                | GET         | Home: the "request paper by DOI" box plus the feed of active requests |
| `/`                                | POST (form) | Login: `user`, `pass`, `action=login` (form-urlencoded, no CSRF)      |
| `/search`                          | POST (JSON) | `{"doi": "..."}` - looks a DOI up; returns an HTML fragment           |
| `/request`                         | POST (JSON) | `{"doi": "...", "reward": 2}` - posts the request                     |
| `/<doi>`                           | GET         | The request page (open or solved)                                     |
| `/cancel/<doi>`                    | GET (link)  | Requester's cancel control on an open request                         |
| `/take/<doi>`                      | GET (link)  | Solver's "take request" control (not ours)                            |
| `/papers`                          | GET         | Library: everything requested, uploaded or viewed                     |
| `/papers/requests`                 | GET         | Only the owner's requests, newest first, with status text             |
| `/papers/solutions`                | GET         | Papers the owner solved                                               |
| `/tokens`                          | GET         | Token balance ("tokens" then the number), top-up and withdraw         |
| `/upload`                          | GET         | Drop zone for solvers                                                 |
| `/logout`                          | GET (link)  | Logout                                                                |
| `/storage/<y>/<n>/<h>/<title>.pdf` | GET         | The uploaded PDF, loaded by the solved request page                   |

The pages are server-rendered; the only XHR/fetch calls are `/search` and
`/request`, both JSON bodies with `content-type: application/json`, sent with
the session cookie.

## Lookup (`POST /search`)

Body: `{"doi":"10.1080/03630269.2026.2729189"}`. The response is an HTML
fragment the home page injects next to the box. Three outcomes were seen:

- `This article was already posted on Sci-Net.` with a link `/<doi>`: the
  request already exists (join it by reading `/<doi>`).
- `DOI not found in Crossref`: bad or unknown DOI (seen for a mixed-case NEJM
  DOI, so lowercase before sending).
- A paper card (year, journal, title, authors, abstract, subjects) followed by
  the request form: `Reward [number input, default 1] tokens [request] [cancel]`.

## Posting (`POST /request`)

Body: `{"doi":"10.1080/03630269.2026.2729189","reward":2}`. Status 200; the
home page re-renders with the new request at the top of the feed and a yellow
reward badge. The request is then readable at `/<doi>`.

## Request page (`GET /<doi>`)

Open request, viewed by the requester:

```
<requester handle>
2026Hemoglobin
<title>
<abstract>
doi 10.1080/03630269.2026.2729189
<subjects>

Reward: 2 token

<solver handle>
This member is working on solving the request and will upload PDF in 30 minutes
```

Markup cues: a link `href="/cancel/<doi>"` (requester) or `href="/take/<doi>"`
(any other member) means OPEN. A line `Reward: N token` carries the bounty.
The solver line appears once someone took it.

Solved request:

```
2026
Foregut: The Journal of the American Foregut Society
<title>
10.1177/26345161261465536
requested
<requester handle>
uploaded
<uploader handle>
```

Markup cues: the words `requested` and `uploaded` with two member links, no
cancel/take link, and the page loads the PDF from
`https://sci-net.xyz/storage/<year>/<n>/<64-hex>/<Title-With-Dashes>.pdf`
(an embedded viewer; the URL is in the page as the embed/iframe source and is
fetchable with the session cookie).

Verify control: on the owner's seven solved requests no verify/confirm control
was visible; whether a fresh solution shows one before it is confirmed is
still to be observed on the request above.

## Library (`GET /papers/requests`)

Rows: `<date time>` / `solved` (or presumably `open`) / `<year>` / `<title>`,
each title linking to `/<doi>`. "Articles that I have requested (N)".

## Tokens (`GET /tokens`)

Text `tokens` followed by the balance (24 at capture time), a top-up form that
takes an invite code, and a withdraw form.

## Corrections to src/scinet/site.ts

- existing check: `POST /search` JSON, not `GET /<doi>`; parse "already posted"
  (join) vs "not found in Crossref" (error) vs card (new).
- request: `POST /request` JSON `{doi, reward}`, not a form with `action`.
- request id: the DOI itself; the page is `/<doi>`; there is no `/request/<id>`.
- open markers: `/cancel/<doi>` or `/take/<doi>` link, `Reward: N token`.
- solved markers: `requested` + `uploaded`, a `/storage/...pdf` URL.
- verify: unknown; see above.
- login redirect: logged-out pages render the login form at `/`.
