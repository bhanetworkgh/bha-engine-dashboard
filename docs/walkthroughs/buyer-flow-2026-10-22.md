# vFarm buyer flow walkthrough, 22 Oct 2026 (LOOP-1792680780254-5SWD)

Walked by Destiny on test lead VFBUYER-FORMA-1TZS4DO (an @bhanetwork.org lead), through the engine's own
buyer-side functions (test_buyer_flow, test_submit_intake2), audit lines 2980 to 2991. Shape: BP-VFARM-1792684852004-3UIY.
Each step is pass, break or feels wrong. Jason's second pass follows.

| # | Step | Result | What happened |
|---|------|--------|---------------|
| 1 | Form A lead held, Stage 1 | pass | Lead at Stage 1, no Form 2, no proposal, no payment. |
| 2 | Move to Stage 2 | pass | Moved; Form 2 invite emailed to the lead (Gmail id 1a164be49836d3a7). |
| 3 | Skip to Stage 3 without Form 2 | pass | Refused: "This lead has not sent Form 2 yet." |
| 4 | Buyer fills Form 2 (31 answers, one PDF) | pass | Submitted on the buyer link (VFINT2-SUB-FORMA-1TZS4DO); file in the lead's Drive folder; post in #vfarm-early-access; receipt emailed (1a164be70d3a4893). |
| 5 | Move to Stage 3 | pass | Moved once Form 2 was in. The five checks are a person's call; recorded as cleared for this test lead only. |
| 6 | Accept before a proposal exists | pass | Refused: "no proposal yet". |
| 7 | Skip to Stage 4 without an accepted proposal | pass | Refused: "This lead has not accepted one." |
| 8 | Make the proposal | pass | VFPROP-FORMA-1TZS4DO-1, test. |
| 9 | Buyer opens the proposal page | pass | Opens on its own link, says "Test proposal", shows no payment link. |
| 10 | Buyer asks a question | feels wrong | Recorded and posted; the buyer is told "We will answer by email", but no one is named to answer and CST does not answer proposal questions yet. |
| 11 | Buyer accepts | break, fixed | Moved to Stage 4. The page told the buyer "We will email you the agreement and your payment link"; nothing sends either and no real buyer may be charged. Changed on all four places on the page to "We will contact you by email about the next steps." |
| 12 | Skip to Stage 5 with no payment | pass | Refused: "No paid Stripe payment is recorded on this lead." |
| 13 | Deposit | not walked, on purpose | Real buyers cannot be charged: charge gate answers No (Hardik's acceptance pass and Jason's live-offer approval not recorded). The rail itself was proven end to end by the live $1 internal payment on 21 Oct (VFBUYER-FORMA-RU0W2P). |
| 14 | Stage 5 on a test payment | feels wrong | VFBUYER-FORMA-3TH40G sits at Stage 5 "Customer" on a test-mode payment from 17 Oct: the Stage 5 gate accepts a test payment. Raised with Jason on 22 Oct; his call. |

Every refusal named its reason, every email and Slack post came back confirmed, and the charge answer stayed No throughout.
