# The Sport menu (match-day prices)

The owner, 2026-11-07: on a match day "the price of cold drink, hot drink and
pastry got increased". His own plan for where the switch belongs:

> "the easiest way to add this is to use that group button, rename the groups to
> sport, then when they click it there will be increased price and they will
> click and send it like normal order"

So the Sport menu is a **second, temporary price list that only the waiter's
ordering screen reads**. The customer's menu, the QR page and the cashier keep
the ordinary prices all night.

---

## 1. What the waiter sees

| Where | What |
| --- | --- |
| Top corner of the tables screen | The wide button that used to say **Groups** now says **Sport menu** (violet when it is on). The Groups button itself is the compact users icon right beside it, and it is also inside the sport sheet. |
| Beside the category chips | A **⚡ Sport menu** chip sits next to All / Hot Drinks / Cold Drinks… Added categories carry a ⚡ on their own chip. |
| Inside the sheet | `Sport prices are ON/OFF`, `Use sport prices`, and (for the owner only) the editor. |
| The food cards | In sport mode a priced item reads `from 50 to 70 ETB` (normal price struck through). An item the owner did not price shows its ordinary price only. |

Tapping **Use sport prices** charges the match-day numbers on that phone. The
cart keeps the price each line was added at, so switching mode on or off never
rewrites money already sitting in the cart. Tap **Stop using sport prices** (or
the owner switches the list off) and the next order is back to the normal menu.

The order itself is completely normal: same stations, same cashier, same bill.

## 2. What the owner does

**Dashboard → Sport menu tab** (also reachable from the waiter app's sheet).

1. **Add a category** (one at a time): Hot Drinks, Cold Drinks, Pastry, …
2. Every item in that category is listed as

   ```
   Cola            from 50 ETB  to  70  ETB   [  70 ]
   Mango Juice     from 80 ETB  to 100  ETB   [ 100 ]
   ```

   He types the match-day price in each box and presses **Save Cold Drinks
   prices**. Struck-through green = raised, rose = lowered.
3. Adding another category is the same two taps.
4. **Switch off for today** when the match is over. Nothing is deleted: the
   typed prices stay for the next match day.

Removing a category also drops its typed prices, so those items return to the
normal price immediately.

## 3. The rules

| Case | Price charged |
| --- | --- |
| Sport on, item has a typed price | the typed match-day price |
| Sport on, category added, item not typed | the ordinary menu price |
| Sport on, category never added | the ordinary menu price |
| Sport switch off | the ordinary menu price, for everything |
| A customer's QR order | the ordinary menu price, always |
| Sale price running that day | the typed sport price wins for that item (it is the newer, deliberate number) |

## 4. The bill and the report (owner, 2026-11-07)

> "if cola is 70 in normal and 150 in sport then when they send it with sport it
> will be 150 and in the report too"

**On the bill:** a line added in sport mode is stored at the match-day price, so
the bill, the cashier screen, the receipt and every report read 150. Proven live:

```
waiter sends 2 Cola with the sport menu   ->  GROUP 1  total 300
waiter sends 1 Cola from the normal menu  ->  GROUP 2  total 50
report todayRevenue                        ->  350   (300 sport + 50 normal)
report popularItems Cola                   ->  3 units, 350 ETB
```

**Per line, not per send.** A table can buy one Cola at the normal price and two
at the match-day price in the same order. Each cart line remembers whether it was
added in sport mode, so:

```
1 Cola (normal 50) + 2 Cola (sport 150) in ONE send  ->  bill total 350
                                                         two rows: 50 and 150
```

Two sport Colas still fold into one row ("2 Cola, 150"); a sport Cola never folds
into an ordinary one, because their money is different.

**In the report:** the match-day money is already inside `todayRevenue`, the
popular items, the category totals and the four station stacks (they all sum the
stored line price). On top of that the report names it:

```json
"sportSales": {
  "tickets": 1, "quantity": 2, "revenue": 300,
  "items": [{ "name": "Cola", "quantity": 2, "revenue": 300 }]
}
```

The Reports tab shows it as a violet **⚡ Sport menu** card, only when sport
lines actually sold.

**The flag lives on the line itself.** A sport line is stamped `SPORT PRICE` on
the stored note (`isSportNote` in `src/lib/order-lines.ts`). The report reads
that stamp, never the current sport list, so:

* editing the list next week never rewrites last Saturday's report;
* switching sport off changes nothing in history;
* deleting the list entirely still leaves the 150 bill explainable.

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
| `POST /api/sport-menu` | the owner only (`requireAdmin`). A waiter's phone gets 401 and the sheet hides the editor. |

`canEdit` comes from the server (the owner's cookie), so a waiter's phone shows
a read-only price list without ever attempting a write.

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
| `src/components/rms/SportMenuSheet.tsx` | the one editor/sheet (waiter overlay + owner tab) |
| `src/components/rms/SportMenuTab.tsx` | the owner's dashboard tab (`?tab=sport`) |
| `src/components/rms/WaiterApp.tsx` | top-corner button, ⚡ chip, cart pricing, sport mode |
| `src/components/rms/GroupComposer.tsx` | group rounds charged the sport prices too |
| `src/db/migrate.ts` | the `sport_menus` table |
| `scripts/verify-sport-menu.mjs` | static guard, 58 assertions |
| `scripts/verify-sport-menu-pricing.ts` | behaviour guard, 34 checks |
| `scripts/verify-sport-menu-ui.tsx` | jsdom mount of the sheet |

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
