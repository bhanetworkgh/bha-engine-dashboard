# vFarm intake: what happens on a double-submit or a retry

**For:** Jason, Hardik, and anyone reading the vFarm Early Access pipeline. **From:** Destiny, 1 Oct 2026. **Loops:** LOOP-1790429563424-IK1D (this page) and LOOP-1790429562412-KQXM (the confirmation email). **Status:** Stage 1 is live and proven. Stage 2 is not live, and this page says how it fails closed.

The pipeline: the /vfarm form (or Google Form A directly) adds a row to Form A's response sheet. Every minute, the n8n tracker `vFarm Early Access Lead → Buyer Link` (fhQNvRFdh1H6Li0E) picks up the new row, writes the lead, writes its lifecycle events, saves it to the dashboard, alerts #vfarm-early-access and emails the person.

## The ids, and which one is the person

| Id | Shape | Made from | Means |
|---|---|---|---|
| `early_access_lead_id` | `VFLEAD-<ms>-<6>` | minted once, the first time an email is seen | **the person**. One per email, ever. |
| `buyer_intake_id` | `VFBUYER-FORMA-<key>` | `<key>` = hash of email + form timestamp | **one submission** |
| `correlation_id` | `VFARM-FORMA-<key>` | same key | the submission's trace id |
| lifecycle event ids | `VFEVENT-LINK-`, `-INTAKE-`, `-CONFIRM-FORMA-<key>` | same key | "this already happened for this submission" |

The key is deterministic: the same submission always produces the same key, and so the same ids. That is what makes every case below safe.

## Stage 1 (Form A): the four cases

**1. The same submission is processed twice** (an n8n retry, the healer re-running a failed run, the sheet trigger firing twice).
Nothing is duplicated. The lead is found by email and updated, not appended. Each lifecycle event, including `form_a_confirmation_sent`, is looked up by its deterministic id first and written only if missing. The dashboard upserts on `buyer_intake_id`, so the row is updated in place (200, not 201). **The person gets one email**: the confirmation is sent only when no `VFEVENT-CONFIRM-FORMA-<key>` event exists.

**2. The same person submits again later** (a new form entry, same email).
It is a new submission, so it gets a new `buyer_intake_id`. It is the same person, so it keeps the same `early_access_lead_id`: the lead row is updated (its `buyer_intake_id` moves to the newest intake) and no second lead is created. The dashboard holds one row per submission, both carrying the same lead id, and the Early Access tab tags the repeat email (neutral, not a warning). The Slack alert says "(returning email)". The person gets the **"Your vFarm Early Access details are updated"** email instead of the welcome one, so they are told plainly what happened to their second entry.

**3. Gmail refuses the email.**
`Confirm Gmail Accepted It` requires a Gmail message id. Without one the run fails, `Bays — Error Handler` raises an incident, and **no `form_a_confirmation_sent` event is written**, so nothing claims the email went. A retry of that run sends it then. Proved with a pinned failure (execution 23578).

**4. The email went but recording it failed.**
The healer resumes a failed run from the failed node, not from the start, so the retry re-runs `Record Confirmation Sent` only, and the person is not emailed twice.

## What the person is told

Both emails come from admin@bhanetwork.org and say, word for word:

- "This confirms your Early Access interest only. It is not a reservation, subscription, purchase, or confirmation of availability or delivery dates." (TSNR EA)
- "vFarm is being developed as a monitored growing system, with cabinet configurations tracked through versioned records. The final P1.0 physical configuration remains subject to canonical approval." (B93H FORM-A, PROVEN_NOW)

The wording comes from the doctrine (`read_media_doctrine`), not from the workflow. If FORM-A or EA is amended, the email changes with it, and that change is posted to the doctrine first.

## Stage 2 (paid / reservation): not live, fails closed

There is no Stage 2 runtime today: no Stripe webhook, no ledger write, no `subscriber_state`. Every lead is written with `subscription_status: none`, and nothing in the pipeline can set anything else. TSNR S2 is `CONTRACT_DEFINED_NOT_RUNTIME_PROVEN`, and TSNR 8.2 (paid founding subscription) is `NOT_SAFE_TO_CLAIM`. So:

- the email never mentions payment, reservation or a subscription except to say it is **not** one;
- a double-submit cannot create a payment state, because there is no payment state to create.

When Stage 2 is built, it must keep the same lineage rule: one `early_access_lead_id` per person, payment events keyed deterministically (for example on the Stripe event id) and checked before they are written, and the person told plainly what a second attempt did. That is a requirement on the Stage 2 build, not something this page proves.

## Known gap (Hardik's lane)

`Save To Dashboard` and `Alert Early Access Channel` are set to continue on error, and the dashboard call never errors on a bad status. A refused dashboard write or a failed Slack alert therefore does not stop the run or raise an incident. The lead is still in the sheet and the person is still emailed, but the dashboard row or the alert can be missing without anyone being told. The fix is to check the dashboard's status code and Slack's `ok`, and raise on failure.

## Proof (1 Oct 2026)

- 23577: pinned, new lead → welcome email built and recorded.
- 23578: pinned, Gmail refused → run failed loudly, nothing recorded as sent.
- 23579: pinned, confirmation already sent → stopped at `Confirmation Not Sent Yet?`, nothing sent.
- 23582: live, a real /vfarm submission → Gmail message `1a0f84202392d8cc` to destiny@bhanetwork.org, event `VFEVENT-CONFIRM-FORMA-1E00T6W` written, dashboard row `VFBUYER-FORMA-1E00T6W` inserted (201). That lead (`VFLEAD-1790871463008-8WGIOS`) is an internal test, labelled "BHA internal test - ignore".
