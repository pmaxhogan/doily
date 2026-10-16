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
| `/<doi>`                           | GET         | The request page (open, solved but unaccepted, or solved)             |
| `/<doi>`                           | POST (form) | "Report problem" on a solution: `message` field (from `/view/<doi>`)  |
| `/cancel/<doi>`                    | GET (link)  | Requester's cancel control on an open request                         |
| `/take/<doi>`                      | GET (link)  | Solver's "take request" control (not ours)                            |
| `/reward/<doi>`                    | POST (form) | Requester raises the reward (number field, `set` button)              |
| `/view/<doi>`                      | GET (link)  | Solution preview; opening it marks the solution as viewed             |
| `/accept/<doi>`                    | GET (link)  | Requester accepts the solution; the bounty moves to the solver        |
| `/papers`                          | GET         | Library: everything requested, uploaded or viewed                     |
| `/papers/requests`                 | GET         | Only the owner's requests, newest first, with status text             |
| `/papers/solutions`                | GET         | Papers the owner solved                                               |
| `/tokens`                          | GET         | Token balance ("tokens" then the number), top-up and withdraw         |
| `/upload`                          | GET         | Drop zone for solvers                                                 |
| `/logout`                          | GET (link)  | Logout                                                                |
| `/storage/<y>/<n>/<h>/<title>.pdf` | GET         | The uploaded PDF, loaded by the solved request page                   |
| `/storage/<32-hex>/<title>.pdf`    | GET         | The uploaded PDF as the `/view/<doi>` preview loads it                |

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

Verify control: on the owner's seven solved requests (all accepted long ago)
no verify/confirm control was visible. A fresh solution does have one: the
requester must accept it, see below.

Solved but not yet accepted, viewed by the requester (captured 2026-10-16 on
the open request above, after a solver uploaded):

```
<requester handle>
2026Hemoglobin
<title>
<abstract>
doi 10.1080/03630269.2026.2729189
<subjects>

Reward: 2 token

<solver handle>
CRISPR-Based-Mediated-Reactivation-of-Fetal-Hemoglobin-as-a-Therapeutic-Strategy-for-Hemoglobinopathies.pdf
view

2 token
The solution has not been viewed yet
```

Markup cues: a form `<form method="POST" action="/reward/<doi>">` with a
number field and a `set` button (the requester can still raise the reward), and
`<a href="/view/<doi>" onclick="hide(this.parentElement)">view</a>`. There is
no storage PDF URL on this page, no `/cancel/` link any more, and the words
`requested` / `uploaded` are absent. So the markers are: a `/view/<doi>` link,
a line that is just the uploaded file name ending in `.pdf`, and the phrase
`The solution has not been viewed yet` (gone once the solution was viewed).
The page still shows `Reward: N token`, so it must be told apart from an open
request before the open markers are checked.

## Solution preview (`GET /view/<doi>`)

Opening it counts as having seen the solution. The page text starts with
`report problem ! accept`, then the DOI, title, year and abstract. Markup:

- `<iframe src="/storage/<32-hex>/<Title-With-Dashes>.pdf">`: the uploaded PDF.
  Note the path shape differs from the accepted pages'
  `/storage/<year>/<n>/<64-hex>/<title>.pdf`; both are fetchable on the same
  host with the session cookie.
- `<a class="accept" href="/accept/<doi>">accept</a>`
- `<a onclick="problem()">!</a>` and `<form method="POST" action="/<doi>">`
  with a `message` field: "report problem".

## Accepting (`GET /accept/<doi>`)

A plain link, sent with the session cookie. The token balance stayed at 24
before accepting; the bounty is transferred on accept. The response to the
accept was not recorded. After acceptance the request page presumably takes
the older solved shape (`requested <user> uploaded <user>` with the embedded
storage PDF); `test/fixtures/scinet/captured-accept-ok.html` assumes exactly
that and is marked as a guess.

## Library (`GET /papers/requests`)

Rows: `<date time>` / `solved` (or presumably `open`) / `<year>` / `<title>`,
each title linking to `/<doi>`. "Articles that I have requested (N)".

With an unaccepted solution the page shows a banner
`You have 1 new requests solved! Please check the solutions and accept them if
they are correct:` followed by the title, and the row's status word is already
`solved` before acceptance. The library row therefore cannot tell accepted
from unaccepted; the request page can.

## Re-requesting your own DOI

`POST /search` for a DOI this account already requested does NOT answer
"already posted on Sci-Net" (that text is for other members' requests); it
falls through to the paper card. `POST /request` then answers 200 without
creating a duplicate (the library still listed 8 requests). So a post is
confirmed by reading `/<doi>` afterwards, and when that page already shows a
solver or a solution (taken, solved but unaccepted, or solved), it was a join
of the earlier request, not a new spend.

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
- solved-unaccepted markers: `/view/<doi>` link, "The solution has not been
  viewed yet", the uploaded `.pdf` file name; checked before the open markers.
- verify: there is none on accepted pages; a fresh solution is accepted with
  `GET /accept/<doi>` after previewing it at `/view/<doi>`.
- login redirect: logged-out pages render the login form at `/`.
