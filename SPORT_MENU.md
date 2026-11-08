# The Sport menu (match-day prices)

The owner, 2026-11-07: on a match day "the price of cold drink, hot drink and
pastry got increased". His own plan for where the switch belongs:

> "the easiest way to add this is to use that group button, rename the groups to
> sport, then when they click it there will be increased price and they will
> click and send it like normal order"

So the Sport menu is a **second, temporary price list that only the waiter's
ordering screen reads**. The customer's menu, the QR page and the cashier keep
the ordinary prices all night.

**The owner corrected the first design (2026-11-08):**

> "when the sports menu button is clicked by the waiter I want the normal menu
> look to come but the different is in admin sport menu the admin will change
> the price for some category and item ... they see prices for that event only
> but same design as the normal menu ... the one who is responsible to edit the
> items is the admin not the waiters too"

There is **no sport screen, no sport mode and no price editor on the waiter's
phone**. The Sport button opens the ordinary ordering screen; the admin is the
only person who can type an event price.

---

## 1. What the waiter sees

| Where | What |
| --- | --- |
| Top corner of the tables screen | The button that used to say **Groups** now says **Sport menu** (violet while the event list is live). The Users icon right beside it is the Groups composer. |
| What it opens | **The ordinary ordering screen.** Same category chips, same food cards, same cart, same send. It picks a free table for him, or the group bill when every table is busy. |
| The food cards | One price each. The item the admin re-priced simply reads his number (`70 ETB`); every other item reads its ordinary price (`50 ETB`). No strike-through pair, no badge. |
| One thin violet bar | `⚡ Event prices: 3 item(s) were changed by the admin.` with a **Normal prices** button. That is the only visible difference, and it disappears the moment he taps a normal table or goes back to the tables screen. |
| Categories | Untouched: All / Hot Drinks / Cold Drinks / … with no ⚡ on the chips. |

The cart keeps the price each line was added at, and only a line whose item has
an event price is marked as a match-day line. The order itself is completely
normal: same stations, same cashier, same bill.

On a day with no live list, or after the admin switches it off, the same button
opens the same screen at the ordinary prices and says
`No sport prices today. These are the normal menu prices.`

## 2. What the owner does

**Dashboard → Sport menu tab** (his own tab, `?tab=sport`). Nobody else can
open the editor: a non-admin who reaches it sees the read-only list.

1. **Add a category** (one at a time): Hot Drinks, Cold Drinks, Pastry, …
2. Every item in that category is listed as

   ```
   Cola            from 50 ETB  to  70  ETB   [  70 ]
   Mango Juice     from 80 ETB  to 100  ETB   [ 100 ]
   ```

   He types the event price in each box and presses **Save Cold Drinks
   prices**. Struck-through green = raised, rose = lowered.
3. Adding another category is the same two taps.
4. **Switch off for today** when the match is over. Nothing is deleted: the
   typed prices stay for the next match day.

Removing a category also drops its typed prices, so those items return to the
normal price immediately.

## 3. The rules

| Case | Price charged |
| --- | --- |
| Event list live, item has a typed price | the admin's event price |
| Event list live, category added, item not typed | the ordinary menu price |
| Event list live, category never added | the ordinary menu price |
| Event list switched off | the ordinary menu price, for everything |
| Waiter tapped an ordinary table on the grid | the ordinary menu price, always |
| The same button when no list is live | the ordinary menu price, plus the "no sport prices today" line |
| A customer's QR order | the ordinary menu price, always |
| Sale price running that day | the event price wins for that item (it is the newer, deliberate number) |

The rule itself is one function, shared by the card and the cart:
`chargePrice(item, menuPrice, eventPrices, catalog)` in
`src/lib/sport-menu-client.ts`.

## 4. The bill and the report (owner, 2026-11-07)

> "if cola is 70 in normal and 150 in sport then when they send it with sport it
> will be 150 and in the report too"

(numbers in that quote are the owner's own illustration. Nothing is seeded: the
table starts empty and only the admin's typed prices ever exist.)

**On the bill:** a line added while the event screen showed an event price is
stored at that event price, so the bill, the cashier screen, the receipt and every
report read it. The line is marked `SPORT PRICE` on its stored note, which is how
the report finds it later.

Proven live (2026-11-08, the admin typed Cola 50 → 70 in the editor; both test
prices were deleted straight after):

```
waiter sends 2 Cola (event price) + 1 Tea (40)  ->  bill total 180
waiter sends 1 Cola from the normal menu        ->  bill total  50
report todayRevenue                             ->  230   (180 + 50)
report popularItems Cola                        ->  3 units, 190 ETB
report sportSales                               ->  { tickets 1, quantity 2, revenue 140 }
```

**Per line, not per send.** A table can buy one Cola at the normal price and two
at the event price in the same order. Each cart line remembers the price it was
added at, so:

```
1 Cola (normal 50) + 2 Cola (event 70) in ONE send  ->  bill total 170
                                                        two rows: 50 and 70
```

Two event Colas still fold into one row ("2 Cola, 70"); an event Cola never folds
into an ordinary one, because their money is different.

**In the report:** the match-day money is already inside `todayRevenue`, the
popular items, the category totals and the four station stacks (they all sum the
stored line price). On top of that the report names it:

```json
"sportSales": {
  "tickets": 1, "quantity": 2, "revenue": 140,
  "items": [{ "name": "Cola", "quantity": 2, "revenue": 140 }]
}
```

The Reports tab shows it as a violet **⚡ Sport menu** card, only when sport
lines actually sold.

**The flag lives on the line itself.** A sport line is stamped `SPORT PRICE` on
the stored note (`isSportNote` in `src/lib/order-lines.ts`). The report reads
that stamp, never the current sport list, so:

* editing the list next week never rewrites last Saturday's report;
* switching sport off changes nothing in history;
* deleting the list entirely still leaves the event bill explainable.

Every human-facing screen strips the tag (`stripSportMarker`), so waiters, crews,
the cashier, order history and the shift report show the waiter's own note only.

## 5. Where the price really comes from (never the phone)

The client only ever sends **which list** (`sportMenuId`). `POST /api/tickets`
re-reads `sport_menus` inside the order transaction and overwrites the unit
price of every line through the same authoritative `priceById` map that a sale
price goes through (`applySportPrices`, `src/app/api/tickets/route.ts`):

* a stale phone holding yesterday's prices cannot charge them;
* a tampered body cannot invent a price (a test sends `price: 1` and the bill
  still reads 70);
* a switched-off list is ignored entirely, so `Switch off` is instant;
* a customer submission (`source: "customer"`) never has a sport list applied;
* a nonexistent list id falls back to the normal price;
* the submission's audit line records `• sport menu #1`, so a bill from last
  Saturday explains its higher tea.

## 6. What is stored

One row in `sport_menus` (its own table, created by `ensureTablesExist`):

```
id | name | active | categories jsonb | prices jsonb | created_at | updated_at
```

`categories` = the slugs he added (`["cold-drinks","pastry"]`).
`prices` = `[{ menuItemId, regularPrice, sportPrice, category }]`.

**Nothing is ever written onto `menu_items`**, so the published menu, the QR
page and the customer checkout cannot change. The public `/api/menu` route does
not mention the sport menu at all.

## 7. Who may read or write

| Call | Who |
| --- | --- |
| `GET /api/sport-menu` | a waiter or the owner (a waiter must see what he charges). A guest gets 401. |
| `POST /api/sport-menu` | the owner only (`requireAdmin`). A waiter's phone gets 401, and the editor is never mounted on his screen at all. |

`canEdit` comes from the server (the owner's cookie), so even the dashboard tab
shows a read-only list to anyone who is not the owner.

## 8. Where it lives

| File | What |
| --- | --- |
| `src/lib/sport-menu.ts` | types, the `sportPriceFor` rule, jsonb cleaning, category views |
| `src/lib/sport-menu-client.ts` | the screen's fetch + `chargePrice` display rule |
| `src/app/api/sport-menu/route.ts` | GET (waiter/owner) and the owner's actions |
| `src/app/api/tickets/route.ts` | the sport block: per-line server price + the `SPORT PRICE` stamp |
| `src/lib/order-lines.ts` | `SPORT_NOTE_TAG`, `sportLineNote`, `isSportNote`, `stripSportMarker` |
| `src/app/api/reports/route.ts` | `sportSales`: match-day money named in the report |
| `src/components/rms/ReportsTab.tsx` | the violet ⚡ Sport menu card |
| `src/components/rms/SportMenuEditor.tsx` | the admin-only editor (one copy, mounted by the tab) |
| `src/components/rms/SportMenuTab.tsx` | the owner's dashboard tab (`?tab=sport`) |
| `src/components/rms/WaiterApp.tsx` | the Sport button, the same ordering screen, cart pricing |
| `src/components/rms/GroupComposer.tsx` | group rounds charged the sport prices too |
| `src/db/migrate.ts` | the `sport_menus` table |
| `scripts/verify-sport-menu.mjs` | static guard, 62 assertions |
| `scripts/verify-sport-menu-pricing.ts` | behaviour guard, 43 checks |
| `scripts/verify-sport-menu-ui.tsx` | jsdom mount of the admin editor |

## 9. Guards

```
node scripts/verify-sport-menu.mjs         # static: storage, editor, waiter, server, customer
npx tsx scripts/verify-sport-menu-pricing.ts   # behaviour: the money rules
```

All three are wired into `npm test`. They fail if anyone later: writes a sport
price onto `menu_items`, lets a guest read the list, drops the server-side stamp,
prices a customer order from a sport list, charges a normal line a match-day
price (or the reverse), folds a sport line into an ordinary one, or lets the
report change its mind about a past match day.
