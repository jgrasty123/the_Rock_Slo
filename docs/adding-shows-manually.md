# Adding shows that aren't on TicketWeb

Most shows appear on the website automatically — anything ticketed through
TicketWeb shows up within about 15 minutes of going on sale, with no work from
anyone.

For shows that **aren't** sold through TicketWeb, there's a Google Sheet. Add a
row, and it appears on the site. That's the whole job.

---

## One-time setup

**1. Create the sheet.** Upload `manual-shows-template.csv` to Google Drive and
open it with Google Sheets. Delete the two example rows.

**2. Publish it.** File → Share → **Publish to web** → choose the sheet tab →
format **Comma-separated values (.csv)** → Publish. Copy the URL it gives you.

This publishes only that tab, read-only, as data. It does not make your Drive
public and it isn't a link people would ever find.

**3. Give the URL to your developer** to add as `MANUAL_SHEET_CSV` in Netlify.

**4. Share the sheet** with whoever at the venue should be able to add shows.

---

## Adding a show

One row per show. Only three columns are truly required: **Date**, **Show
Name**, and **Publish**.

| Column | What to put | Required |
|---|---|---|
| Date | `2026-09-14` or `9/14/2026` | **Yes** |
| Time | `8:00 PM`, `8pm`, or `20:00`. Blank means 7:00 PM | No |
| Show Name | The headliner, as it should read on the site | **Yes** |
| Support | Opening acts, e.g. `w/ The Sandbaggers` | No |
| Price | `$15`, `$15–$25`, or `Free` — typed exactly as it should display | No |
| Ticket Link | Where people buy. Blank shows a "More Info" button instead | No |
| Image URL | Direct link to a poster or photo. Blank shows a dark placeholder | No |
| Age | `21+`, `All Ages`, `18+` | No |
| Publish | `yes` to show it on the site. Anything else hides it | **Yes** |
| Notes | For your own use — never appears on the site | No |

### Things worth knowing

- **`Publish` must say `yes`.** A half-finished row sits invisible until you say
  so, so it's safe to draft shows in advance.
- **Past shows disappear on their own.** No need to delete old rows, though
  tidying up occasionally keeps the sheet readable.
- **Changes appear within about 15 minutes.** The site caches to stay fast.
- **If a show later goes on sale through TicketWeb**, the TicketWeb version wins
  automatically and your row is ignored — no duplicate card, nothing to clean
  up. You can leave the row alone.
- **Deleting a row removes the show** from the site at the next refresh.

### If a show doesn't appear

Check, in this order:

1. `Publish` says `yes`
2. The date is in the future and formatted like the examples
3. `Show Name` isn't blank
4. It's been more than 15 minutes

If all four are true and it's still missing, the sheet may have stopped being
published — re-check File → Share → Publish to web.

---

## What this is not

This sheet is for shows only. It doesn't control the rest of the website, and
nothing typed here can break the site — if the sheet is unreachable, TicketWeb
shows still display normally.
