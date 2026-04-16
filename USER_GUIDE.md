# Inventory System — User Guide

A step-by-step reference for everyone who counts, pulls, receives, transfers, or reviews inventory across our three facilities: **SATC**, **Pharr**, and **Wilco**.

---

## 1. Getting In

- **URL**: (your team lead will share the live link — on local setup it's `http://localhost:3100`)
- **Works on phone, tablet, or computer.** Add the home page to your phone's home screen for one-tap access.
- **No login for staff.** You only type your name into the form — that name stays attached to the record.

When you open the link, you'll land on the **Home screen** with three sections:

- **Count Schedule** — shows when the next bi-weekly and monthly counts are due.
- **Count Forms** — Bi-Weekly Count and Monthly Count.
- **Inventory Actions** — Log Inventory Activity (pulls, receipts, transfers).
- **Admin** — Admin Dashboard (requires an admin key — only managers).

---

## 2. The Two-Location Rule (read this first)

Every item lives in **two places**:

- **Storage** — the backroom / stockroom / closet. Items that are not available to customers yet.
- **Display** — the floor / retail shelf. Items customers can see and buy.

When you do a count, you count **both places separately**. The app has two columns for every item. Don't combine them into one number.

---

## 3. Doing a Bi-Weekly Count

**What gets counted:** strings, ball cases, concessions (water), supplies (toilet paper, hand soap).

**How often:** every 2 weeks. The home-screen card tells you when the next one is due.

**Steps:**

1. Open the home page → tap **Bi-Weekly Count**.
2. Tap your **facility** (SATC, Pharr, or Wilco).
3. For each item, count what's in **Storage** and what's on **Display**. Use the − / + buttons or type the number. Zero is fine — leave items you don't have at 0.
4. Scroll to the bottom, enter **your name**.
5. Tap **Submit Bi-Weekly Count**.

**Tips:**
- If an item is marked "Open Cans" (partially-used ball cases), count those separately from "Full Cases."
- Double-check before submitting — you can't edit a submission, but you can submit a new count if you find a mistake.

---

## 4. Doing a Monthly Count

**What gets counted:** grips (Prime Tour, Pro), wristbands, headbands, rackets.

**How often:** once a month.

**Steps** — same as bi-weekly, just from the **Monthly Count** button on the home page.

**Tips:**
- Prime Tour Grips are counted by color (white, black, pink, blue).
- Pro Grips are counted as a single total.
- Wristbands and headbands are by size + color.
- Rackets are by model.

---

## 5. Logging Inventory Activity

When you move inventory **outside of a scheduled count**, log it in the **Log Inventory Activity** form. Three modes — pick the right one.

### 5a. Pull (Storage → Display)

**Use when:** you're restocking the floor — moving items out of the backroom and putting them on display.

**Effect on totals:** none. The item stays in the facility's total — it just moves from Storage to Display.

**Steps:**
1. Home → **Log Inventory Activity** → tap **Pull** (green).
2. Select the **facility** you're pulling at.
3. Pick the **category** and **item**.
4. Set the **quantity** (how many you moved).
5. Enter your **name**, any **notes** (optional).
6. Tap **Log Pull**.

### 5b. Receive Shipment (External → Storage)

**Use when:** a new shipment arrived from a supplier. The boxes go into the backroom.

**Effect on totals:** increases. New stock is added to Storage.

**Steps:**
1. Home → **Log Inventory Activity** → tap **Receive** (amber).
2. Select the **facility** that received the shipment.
3. Pick the **category** and **item**.
4. Set the **quantity** received.
5. Enter your **name**.
6. Tap **Log Receipt**.

**Important:** do this **on the day the shipment arrives**, not later. Otherwise the dashboard estimates will be wrong until the next count.

### 5c. Transfer (Facility → Facility)

**Use when:** you're sending stock from one of our facilities to another.

**Effect on totals:** source facility decreases, destination increases. Company total unchanged.

**Steps:**
1. Home → **Log Inventory Activity** → tap **Transfer** (blue).
2. Select the **From Facility** (where the stock is leaving).
3. Select the **To Facility** (where it's going). You can't pick the same facility for both.
4. Pick the **category** and **item**.
5. Set the **quantity**.
6. Enter your **name** and **notes** (optional).
7. Tap **Log Transfer**.

**Tip:** only one person (the sender) needs to log the transfer — the receiver will see it show up automatically in their dashboard.

---

## 6. What NOT to Log

- **Sales.** Do not log individual sales in this app. Sales are tracked in the POS system, and we reconcile against POS at each bi-weekly count (see Section 8).
- **Restocking inside storage** (moving one box over). Not needed.
- **Damaged / returned items.** For now, note these in the next count. If this becomes frequent, flag it and we'll add a proper "write-off" action.

---

## 7. Admin Dashboard (Managers)

**URL:** `/admin.html` — you'll be asked for the admin key on first visit.

The dashboard has **six tabs**:

- **SATC / Pharr / Wilco** — one tab per facility. Each tab shows two tables (Bi-Weekly and Monthly items) with columns: **Item | Storage | Display | Total | Activity Since | Status**. "Activity Since" summarizes pulls, receipts, and transfers that happened after the last count.
- **All Facilities** — sums every facility into one view. Low-stock alerts fire here, based on company-wide totals.
- **Reconcile** — POS reconciliation tool (Section 8).
- **History** — trend chart + full event log (every count, pull, receipt, transfer) with filters.

**Red row = low stock alert.** The alert banner at the top lists everything below threshold.

**"Overdue" badge** on a facility section = the current count cycle is past due. Follow up with the staff on that facility.

---

## 8. Reconciliation — The Key Workflow

**Why:** this is how we catch shrinkage, miscounts, or unlogged activity. After every bi-weekly count, we compare what the app thinks we sold against what the POS says we sold.

**When:** right after the second (and every subsequent) bi-weekly count is submitted. Monthly counts can be reconciled the same way.

**Steps:**

1. Pull the POS sales report for the period — from the **previous** count date to the **current** count date.
2. Open the admin dashboard → **Reconcile** tab.
3. Pick the **facility** and **period** (Bi-Weekly or Monthly).
4. Review the table. Each row shows:
   - **Previous** — total at last count
   - **Current** — total at this count
   - **Received** — shipments logged during the period
   - **Transfers** — moved in (+) or out (−)
   - **App Sales** — sales logged in the app (usually 0)
   - **Expected Sold** — what the app thinks should have sold, given the other numbers
5. For each item that had sales, **type the POS-reported sold quantity** in the POS Sold column.
6. The **Variance** column instantly shows:
   - **✓ Match** (green) — POS = Expected. All accounted for.
   - **Negative number** (red) — inventory dropped more than POS accounts for. Likely shrinkage, miscount, or unlogged activity.
   - **Positive number** (red) — POS recorded more sales than inventory supports. Likely a miscount (or a receipt you didn't log).
7. Type your **name** and click **Save POS Entries**. You can come back and edit later.

**How to investigate a variance:**

- **Recount the item first.** Most variances are miscounts.
- Check for unlogged receipts — did a shipment arrive that no one recorded?
- Check History tab for that item to see the full activity chain.
- If numbers still don't add up after a recount, escalate.

---

## 9. Frequently Asked Questions

**Q: I forgot to log a pull — what do I do?**
A: Log it now with a note explaining the delay. If the count has already happened, the numbers are already "correct" (the count physically reflects reality), but the dashboard activity log will show the pull slightly out of order.

**Q: I submitted a count with a wrong number.**
A: Submit a new count with the corrected numbers. The dashboard always uses the most recent count. Leave a short note in your name like "Maria (correction)."

**Q: The dashboard says an item is LOW, but I know we just got a shipment.**
A: Log the receipt. The dashboard only knows about shipments you record.

**Q: Can I count an item we don't stock?**
A: Leave it at 0. Don't try to delete it.

**Q: A new product is coming in that isn't in the list — now what?**
A: Tell the admin. Adding a new item requires a small code change.

**Q: The app is slow or frozen.**
A: Close and reopen the browser. Your unsubmitted count will be lost, so submit in batches if you have a lot of items.

**Q: Who can see what I submitted?**
A: Any manager with the admin key. Your name is attached to every submission.

---

## 10. Cadence Summary

| Task | Who | How Often |
|---|---|---|
| Bi-Weekly Count | Assigned staff per facility | Every 2 weeks |
| Monthly Count | Assigned staff per facility | Once per month |
| Log Pull | Whoever restocks the floor | Same day |
| Log Receipt | Whoever unpacks the shipment | Same day |
| Log Transfer | The sender | Same day |
| Reconcile vs POS | Assigned manager | After each bi-weekly count |
| Review alerts | Manager | Whenever the app flags a LOW item |

---

## 11. Who to Contact

- **App issues, missing items, general questions:** [your team lead]
- **Admin key / dashboard access:** [your team lead]
- **Ordering decisions based on LOW alerts:** [your purchasing contact]
