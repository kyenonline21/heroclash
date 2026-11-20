LOCAL CONFIG, LOGIN, BOT RESULTS, CHESTS, HERO UPGRADES, RANKING, SHOP AND QUESTS

Requirements: Node.js 22.13 or newer (tested with 25.2.1).
Uses built-in node:sqlite; an ExperimentalWarning on some Node versions is
expected. No npm install is required.

Start from the Unity project root in PowerShell:
  node .\Server\bootstrap-server.cjs

Open:
  http://127.0.0.1:38500/mph_config.json
  http://127.0.0.1:38500/JSONCharacterTable.json

UNITY EDITOR
1. Open the startup scene containing LogoMgr.
2. Enable "Use Local Bootstrap" on LogoMgr.
3. Set "Local Bootstrap Url" to http://160.250.186.219:38500
4. Leave "Editor Server Live" disabled to use the existing development flow.
5. Enter Play Mode.

Expected sequence:
  GET /mph_config.json -> 200
  GET /JSON...Table.json -> 200 (26 tables on a fresh/development run)
  API check_login -> success
  New/pending account: original combat tutorial, then enter a nickname
  API user_nickupdate -> success
  API check_lobby -> success
  API character_getlist -> success

Stop the OLD server with Ctrl+C and run the command again to load
the new APIs. This server is not a file watcher.

TUTORIAL AND STARTER DATA
Tutorial is preserved, not skipped. Local accounts that have not finished
the nickname step return login result "2" and enter the combat tutorial,
even if this PC has tutorial preferences from the old server.
Finish the tutorial (or its existing Skip button) and enter a nickname.
user_nickupdate saves tutorial completion and grants the CommonTable rewards
once: currently 100 gold and 5 jewels, plus the grade-2 tutorial chest in
slot 3. Starter heroes come from TutoReward_Char_1 and TutoReward_Char_2
(currently 201001 and 201002), at character level 1 / skill levels 0.
They are present on the local account from creation.
Repeated completion with the same nickname is safe; a different free
nickname after completion is rejected.
The lobby chest guide can unlock slot 3 via chest_unlock. Its timer uses
the real table duration (currently 180 minutes), and retries do not reset it.
The following guided gem battle now registers an entry and saves its result.
Chest opening is available as described below. UWP rewarded ads require
the optional Vungle configuration described in UWP STORE AND VUNGLE.

TUTORIAL RECOVERY
check_lobby includes tutorial_completed ("0"/"1") from the server account,
not client PlayerPrefs. In local mode, both lobby-load and lobby-refresh
callbacks resume InGameScene_TUTO when this flag is "0", resetting only
tutorial guide preferences, not the guest identity or server account.
Finish the tutorial or use Skip, then submit the nickname successfully.
The tutorial's Home button opens the required nickname popup instead of
loading the lobby directly. Only a successful user_nickupdate callback
allows Home to leave the first tutorial; API errors keep the popup open.
Replaying the tutorial from Settings (TUTO=2) still returns to the lobby
without requesting another tutorial nickname or granting starter rewards.
Only user_nickupdate completes this step and grants starter rewards once.
Setting TUTO/PlayTotorial locally does not complete the server tutorial.
Error 4003 "Complete the tutorial nickname step before entering a battle."
means the account has not completed that step; it is not a network/JSON
parse error. Restart the updated server and launch from the startup scene.
Do not delete PlayerPrefs/database to fix it: clearing client preferences
creates a new guest account instead of repairing the existing one.

BOT BATTLE RESULTS (STEP 3)
Local Bootstrap clients always match against bots, even at level 5 or above;
remote matchmaking is unchanged when Local Bootstrap is disabled.
The combat tutorial is unchanged and still finishes via user_nickupdate.
Modes: 1 = gem team battle, 2 = team defense, 3 = Battle Royale.
The client creates one room_id before entering and keeps it through results.
game_entryfee registers that ID with the account, mode, hero and map, and
deducts the table entry fee once. Team modes are currently free.
Battle Royale currently costs 1 jewel. Insufficient balance blocks entry.
Quitting a paid battle does not refund its entry fee.
Reusing a completed ID for a new entry or changing its identity is rejected.

game_singleresult only accepts a registered bot battle (entry_user_cnt=1).
Team outcomes: win=1 victory, 2 defeat, 3 draw. BR uses battle_rank=1..8.
On local BR timeout while still alive, rank is surviving opponents + 1,
as selected for this development backend; it is not a shared first place.
Amounts come from JSONIngameRewardTable, not client-supplied reward amounts.
Team rows use IngameModeType=1; BR rank rows use IngameModeType=2.
Varying chest probabilities are cumulative weights out of 10000, with any
remaining probability meaning no chest. The result is stored, not rerolled.
This is a reconstruction of local rules, not proof of the old server logic.

Selected gold-budget policy: winGold + mvpGold share the per-mode BonusGold
budget; base gold is allocated first, then MVP gold from the remainder.
Mode timers reset the consumed budget at the table's UTC reset schedule.
EXP/trophies/chest rolls continue even when the gold budget is exhausted.
Only the submitting player as MVP earns the table MVP gold (team modes).
boosterGold is 0 until the booster feature is implemented.
Hero trophies cannot fall below 0; the response shows the actual delta.
Account trophy_sum is the sum of owned hero trophies; trophy_max is its
historical maximum. Victories increment win_sum (BR: first place only).
EXP determines account level using AccumulateExp. Crossed levels grant
their configured rewards once: the original table grants 2 jewels for each
newly reached level. EXP stops at the final level threshold.
GetEntryFee is a separate result payout in the mode's entry currency,
not a second charge or an unconditional refund.
A rolled chest occupies the first empty slot 3-6, locked. chestReceive is
1 for granted, 0 for no roll, -1 for full slots; chestGrade describes the roll.
The play-chest counter increments once per completed battle, up to its goal.

Entry charges, saved battle results and all state changes use SQLite
transactions. Identical retries return the saved response without charging
or granting again, including after restarting the server. A changed outcome
for the same ID is rejected. Session IDs are not stored in result payloads.
Existing step 2 databases are retained; the battles table is added on startup.
Old in-progress matches have no entry record: stop Play Mode and start a
fresh battle after upgrading.

TEST LOOP
1. Restart the server, then launch the startup scene in Unity.
2. Finish the tutorial if this guest account is new.
3. Enter a bot battle from the lobby; terminal: API game_entryfee -> success.
4. Finish it; terminal: API game_singleresult -> success.
5. View rewards and return home: check_lobby/character_getlist load saved data.
6. Restart server and client to verify balances, EXP, trophies and chests.
Local result ads are available only on configured UWP/Vungle builds.
The old unverified game_double endpoint remains disabled.
Chest opening and upgrade spending are available below; multiplayer is not.
This validates reward accounting, NOT authoritative anti-cheat: local bot
outcome/rank/MVP are reported by the client. A modified client can invent
new entries/outcomes. Do not use this backend as-is for public competition.

CHESTS AND HERO UPGRADES (STEP 4)
Slot 1: free chest. Wait the table cooldown (currently 360 minutes).
After opening, it stays in slot 1 and receives a new server-side deadline.
Slot 2: play chest. Complete 10 battles, then open it. Its counter resets
to 0 and can be earned again. No gold/jewel entry fee is charged to open it.
Slots 3-6: reward chests from the tutorial or battles. chest_unlock starts
the table timer. Only one unexpired reward-chest timer may run at once.
Opening an expired timer is free and clears that slot.
Shop purchases open their chests directly, not through these slot APIs.
Other event chest types are not implemented by these slot APIs.

The existing UI also supports paying jewels to open a reward chest now:
- Locked: max(1, floor(OpenTime minutes / 10)).
- Running timer: floor(remaining minutes / 10) + 1.
- Finished timer: 0.
For example, a locked 180-minute chest costs 18 jewels. The initial tutorial
grants 5 jewels; save more jewels or wait for the timer. Timers are unchanged.
The server calculates the price and checks the balance itself.
There is no ad bypass for the free chest. Configured UWP builds can reduce
a reward-chest timer once per chest instance by CommonTable.AdChestTimeCut
(currently 60 minutes), only after a verified Vungle server callback.

Gold, jewel and each rarity roll are independent probabilities out of 10000,
followed by an inclusive Min..Max amount roll. The original Jewel_Min,
Jewel_Max and GetJewelRate values are restored for all 34 jewel-enabled
chest rows, not replaced by a universal jewel reward.
Examples: free chest 301001 gives 1..2 jewels at 5%; play chest 302001
gives 1..2 at 10%; normal 304001 gives 1 at 2%; 304002 gives 1..2 at 1%;
304003 gives 1..3 at 0.5%. Chests whose original jewel rate is zero still
give none, including the existing league/global weekly reward chests.
A successful nonzero rarity roll gives one bundle of cards for one hero
of that rarity. Existing heroes gain cards; a new hero is added at level 1
with skill levels 0 and receives all cards in the bundle.
Only released player heroes (Type=0, ViewType=1, Tier=1..4) can be drawn.
Per-chest weights come from ChestCharacterRateTable for that exact ChestID
and are normalized within the hero's actual Tier (not the ID prefix).
Selected reconstruction policy: when that chest has no explicit rows,
use equal weights among released heroes of the requested rarity.
ChestID=0 legacy rows exist, but are not used as a guessed universal fallback;
the selected uniform policy is used for free, play and 304003 chests.
No fabricated rewards are added: a chest may legitimately yield nothing.
These are documented reconstruction rules, not a claim about the old server.

character_upgradeskill supports skill_type 0=HP, 1=primary, 2=super.
Each skill uses the next Level row for that hero's Tier in
CharacterUpgradeTable. The server debits Upgrade_Gold and Upgrade_HeroStone;
other skills stay unchanged. Maximum is level 7 per skill.
Selected display policy: char_lv = 1 + health_lv + primary_lv + super_lv,
so the overall display level ranges from 1 to 22.
Starter tier-1 skill level 0 -> 1 currently costs 10 gold and 2 hero cards.

Chest/upgrade mutating APIs require a request_id. The local client generates it
once before queueing and retains it for transport retries.
The SQLite mutations table saves state and the response in one transaction:
same account + same ID + same parameters returns the original response;
reusing that ID for a different operation/payload is rejected.
chest_instance identifies the particular chest currently in a slot, so a
stale request cannot consume a later chest reusing that slot or ChestID.
expected_level prevents a stale upgrade click from buying a second level.
Do not reuse request IDs for deliberate new actions.
Existing databases are retained. The mutations table is added on startup;
missing slot identities are populated on the next authenticated API call
without resetting balances, heroes, counters or deadlines.

CHEST/UPGRADE TEST LOOP
1. Stop Play Mode, restart the server and log in from the startup scene.
2. Finish the tutorial if needed. Unlock its slot-3 chest normally and
   verify its countdown remains unchanged after restarting.
3. Open when ready, or use the jewel button if your account can afford it.
   Verify rewards, remaining jewels and the emptied slot.
4. Play 10 bot matches to open the play chest without waiting for a timer.
   Its reward contains common and rare hero cards; the count resets to 0.
5. On a hero with enough cards and gold, upgrade HP/primary/super.
   Verify the displayed skill, cards, gold and overall hero level.
6. Restart both server and client and verify everything persists.
The automated tests seed temporary SQLite state to cover long timers and
high costs without altering real account data or production table values.

RANKING
The existing Ranking screen now supports both Total and Weekly tabs.
ranking_list uses the current trophy_sum (sum of owned heroes' trophies),
not the historical trophy_max. Losses can lower the total ranking score.
ranking_weekly adds only positive actual trophy deltas from completed bot
battles; losses do not subtract weekly points. All three bot modes count.
Accounts that finished the tutorial participate, including zero scores.
Unfinished tutorial accounts are excluded and receive my_rank="0"; the UI
displays "-" rather than trying to draw a medal for rank zero.
Only local player accounts appear: simulated match bots are not accounts.

Selected week boundary: Monday 00:00 Vietnam time (fixed UTC+7), equivalent
to Sunday 17:00 UTC. next_ranking uses the legacy UTC yyyyMMddHHmmss format.
A new week starts at zero automatically when queried or a result arrives;
no scheduler is required. Hero trophies and overall ranking are not reset.
The result-acceptance time selects the week, not the battle entry time.
Replaying a previously completed battle never adds points to either week.
Weekly points and the battle receipt commit/roll back in the same transaction.
The weekly_scores table is added on startup without deleting existing data.
Weekly points begin with this update; old results are not backfilled.

Both tabs return Top 100 and separate personal rank/score even outside Top
100. Equal scores are ordered by ascending GSN, producing unique positions.
The SQL query only returns the top rows and the requesting player's row.
No fake players are inserted to populate the board.
In local mode, opening either tab refreshes it so a just-finished battle is
visible immediately. An open weekly tab refreshes after the week expires
(transport retries/errors remain subject to the existing client flow).
Remote mode retains its existing 60-second tab cache behavior.
Weekly prizes and league settlement use the same weekly points and boundary;
see LEAGUES AND WEEKLY REWARDS below. This is a development leaderboard using
client-reported bot outcomes, not an authoritative competitive service.

RANKING TEST LOOP
1. Restart the server, log in from the startup scene and open Ranking.
2. Check Weekly and Total; a new account has score 0 and is still ranked.
3. Win a bot match and reopen Ranking: both scores should increase.
4. Lose a match: total trophies may decrease; weekly points do not.
5. Restart server/client and check the same scores are preserved.
6. Log in with another guest to see multiple players on the board. Keep
   each guest identity if you want to return to that account later.
Automated tests cover Top 100, ties, personal rank outside Top 100, session
isolation, restart persistence, exact week boundaries and atomic rollback.

LEAGUES AND WEEKLY REWARDS
Implemented: league_list, league_weekly, league_rewardclaim and league_ack.
The mailbox is NOT used for these rewards. Season prizes retain their own
durable pending-reward queue; see MAILBOX for separate mail and gifts.

Season: Monday 00:00 Vietnam time (UTC+7) to the following Monday.
League points are the existing weekly positive actual trophy gains.
Losses do not subtract weekly points. Equal scores use ascending GSN.
Completing at least one accepted battle enrolls an account for that week,
using its league at completion time. Entering/abandoning a battle does not.
A loss at zero trophies still counts as participation, even with score zero.
Inactive accounts keep their league and receive no league/weekly prize.
Tutorial-unfinished accounts cannot access these four league APIs.

There are 17 leagues, ordered by JSONLeagueTable.LeagueOrder.
Within each league, only that week's participating accounts are ranked.
PromoteRank and DemoteRank are rates per 10,000, not absolute positions:
  promoted count = floor(participants * PromoteRank / 10000)
  last safe rank = max(promoted count,
                        floor(participants * DemoteRank / 10000))
Ranks above the promoted count and at/before the safe rank stay in league.
Ranks strictly greater than the safe rank demote. A singleton with positive
points promotes, except in the highest league. A zero-point singleton in a
higher league may demote because the safe rank can floor to zero.
Bottom league never demotes; highest league never promotes.
Example: 10 players, PromoteRank=3000, DemoteRank=7000 -> ranks 1..3
promote, 4..7 stay, 8..10 demote. No random bots fill the league.
league_list returns pRank as promoted count and dRank as last safe rank.
For the bottom league dRank="0" means demotion is disabled; elsewhere zero
can mean all participants are below the safety cutoff.

At settlement, each participant receives:
- One chest from JSONLeagueRewardTable, based on OLD league and league rank
  (rank 1, 2, 3, or 4+). Promotion does not change this week's prize chest.
- One additional chest if its GLOBAL weekly rank is 1..50, from
  JSONWeeklyRankingRewardTable (rank 1, 2, 3, or 4..50).
Global rank is identical to ranking_weekly: all tutorial-complete accounts,
including inactive zero-score accounts. Thus an inactive zero-score account
can rank ahead of an active zero-score account by GSN, but receives no
reward itself. Skipped prizes are not reassigned to lower ranks.
The weekly prize table is server-only and not added to the 26 config URLs.

Settlement happens on the first API request after the boundary, including
login, before accepting new-week results. No scheduler/cron is necessary.
Offline participants are settled too, without changing login/streak activity.
Each old week commits league grades, frozen standings, prize IDs and its
settlement marker in one SQLite transaction. Restarting/requesting again
does not settle the week twice. Standings are frozen at settlement and do
not change with later nickname, grade or score changes.
A battle entered before the boundary but completed afterward belongs to
the NEW week and enrolls in the updated league. Each request uses a single
season cutoff for settlement, scoring and enrollment, even if wall time
crosses Monday while processing it. A replay of an old battle
does not enroll or score again.

Opening the settlement popup:
1. Log in or open League after a week has ended. league_flag stays "1"
   while any settlement remains unacknowledged.
2. View the frozen old-league ranking. Press OK to open the next pending
   chest, then close its existing reward display and repeat for any next
   prize. A global Top 50 participant can have two chests.
3. After all prizes, OK shows the promotion/stay/demotion page.
4. OK acknowledges that season. If more seasons are pending, the oldest
   remaining one is shown; otherwise return to the lobby.
Closing before completion or restarting does not discard pending prizes.
Earned season chests do not use slots 1..6 and are not auto-opened.
Currencies/cards and the open-chest quest counter change only upon a
successful claim/open, not when settlement creates the pending reward.
All rewards use the shared chest engine, with existing card pools and
uniform released-hero selection where no explicit chest weights exist.
Claim and acknowledge calls require request_id. Retry the SAME request ID
and payload to recover the original response, never a second reward roll.
A different request ID cannot reclaim an opened chest. Other accounts
cannot claim/acknowledge someone else's rewards. Ack is rejected until
every reward in that season has been claimed.

Startup adds league_members, league_periods, league_results and
season_rewards without deleting the existing SQLite database.
Existing current-week weekly_scores rows are enrolled using current grade:
those rows were created only by completed battles in the earlier server.
Earlier historical weeks are not backfilled with fabricated seasons.
Once league tracking is installed, overdue participating weeks settle in
chronological order and multiple unacknowledged seasons remain available.
No prizes/league changes are manufactured for weeks without participation.

Approved table correction: RareCard Min/Max were reversed for four chests.
307131 now 40..45; 307132/307133 now 39..44; 307134 now 38..43.
These source JSON ranges were swapped, not silently repaired at runtime.
ChestTable config version was increased for this correction (currently 4,
including the later restoration of the original jewel reward ranges).
All referenced reward chests and card pools are validated at startup.

LEAGUE TEST LOOP
1. Restart server, launch from startup, finish tutorial if necessary.
2. Open League: no participants until an accepted battle completes.
3. Finish a battle, reopen League and compare points with Weekly Ranking.
4. After Monday 00:00 UTC+7, log in/open League to show settlement.
5. Open all pending chests, check balances/cards, acknowledge the grade
   result, restart and verify no duplicate prize or repeated grade change.
6. An account without a completed battle that week gets no settlement.
For fast boundary tests, use the automated suite's isolated temporary
databases and mocked clock; do not change the PC clock, real database or
shorten the production week. Tests cover all 17 league rate cutoffs,
league/global rank rewards, zero-point participation, Monday boundary,
late/replayed battles, pending seasons, ownership, restart and rollback.
This remains client-reported bot play, not authoritative competition.
Realtime play, anti-cheat and real-money payments are separate work.

SHOP (IN-GAME CURRENCIES ONLY)
Implemented: shop_getshopinfo, shop_buyitem and shop_freechest.
Finish the tutorial and log in before opening Shop.
The server reads active StoreType=0 products from JSONShopTable:
- Category 2 / ItemType 2 / MoneyType 3: daily hero cards, paid with gold.
- Category 3 / ItemType 3 / MoneyType 2: instant chests, paid with jewels.
- Category 5 / ItemType 5 / MoneyType 2: gold, paid with jewels.
- Category 6 / ItemType 0 / MoneyType 2: reroll daily offers, paid with jewels.
Inactive products, unavailable heroes, other categories and real-money
products are rejected. Price, count and currency come from the server table;
client-supplied prices/counts are not trusted. No table balances were changed.

Current gold offers:
  500001: 1000 gold for 20 jewels.
  500002: 1500 gold for 50 jewels.
  500003: 5000 gold for 140 jewels.
Important legacy mismatch: the old client calls product 500001 Gold Doubler
and treats its count as booster capacity, but this table defines normal gold.
Local mode now labels it Gold and sets the authoritative gold balance.
The booster gauge/capacity label are hidden; the info button explains the
local limitation. booster_gold_max and booster_gold are both "0".
Battle booster rewards remain disabled. Remote behavior is unchanged.

Current instant chest offers:
  300001 -> chest 303001, 70 jewels.
  300002 -> chest 303002, 160 jewels.
  300003 -> chest 303003, 500 jewels.
Purchase debits jewels and grants rolled rewards immediately. It does not
occupy, unlock or require an empty reward-chest slot.
Gold/card rewards reuse the existing chest reward rules and exact
table ranges/rates. Missing per-chest hero weights use the previously
selected uniform released-hero policy. New heroes start at level 1, skills 0.

DAILY OFFERS AND RESET
Selected reset policy: 00:00 UTC every day (07:00 Vietnam time).
This is separate from the weekly ranking reset at Monday 00:00 UTC+7.
Five unique hero-card products are selected per account by the server.
The tier selection follows the existing client rules:
  two common offers;
  one rare (50%) or common (50%);
  one epic (10%) or rare (90%);
  one legendary (20%) or epic (80%).
The display list is sorted by actual hero tier, then table CategoryOrder.
Unavailable heroes are excluded; IDs do not reliably encode actual rarity.
Each offered product can be bought once per generated list. A card purchase
adds ItemCount cards, or creates that hero and gives the full card count.
The UI uses authoritative remaining gold and current card count.
Gold and instant chests can be bought repeatedly while funds are sufficient.

Product 600001 costs 20 jewels and generates a new list with all offers
unbought. It keeps the normal daily reset deadline and free-gift claim flag.
Rerolling can select some or all of the same heroes; it is not guaranteed
to change every product. Only a successful new paid reroll enables another
purchase of a product already bought in the prior list.
The list and sold-out flags persist across reopening, relogin and restart.
Changing PlayerPrefs or the device date cannot bypass server-side limits.
On the first shop access after UTC midnight, new daily state is generated.
No scheduler is required; an open local Shop checks expiry and reloads.
Offers from an expired day/list cannot be purchased by a stale request.

FREE SHOP GIFT
shop_freechest grants chest 303004 (currently 15-30 gold plus its optional
common-card roll), separately from lobby free chest slot 1.
Selected policy: once per UTC day, available immediately on the first day.
Paid rerolls do NOT restore this free claim. It becomes available again at
the next UTC midnight, not 24 hours after the last claim.
The server returns next_free as a UTC yyyyMMddHHmmss timestamp and preserves
the real gold/jewel balances, including when the chest gives no jewels.

PERSISTENCE, RETRIES AND CLIENT INTEGRATION
shop_getshopinfo returns booster_gold_max, booster_gold, curGold, curJewel
and shop_info. shop_info contains:
  shop_instance, shop_day (yyyy-MM-dd UTC), next_refresh, next_free,
  items: [{ product_id, bought }] with numeric values encoded as strings.
shop_buyitem additionally returns product_id, item_id, item_count,
remain_value (remaining payment currency), curGold, curJewel and shop_info.
Card purchases include curCount. Instant chests include gold, jewel, gSeq,
jSeq and card objects as required by PopupChestOpenSequence.
shop_freechest returns the same chest reward fields and shop_info.

All purchases/claims require a request_id generated once when queued.
shop_buyitem also requires the displayed shop_instance; shop_freechest
requires shop_day. These fields remain unchanged on transport retries.
The existing SQLite mutations table commits the debit, grant, sold-out/free
state and original response atomically. Identical retries return the receipt,
including after restart; a changed payload/action under the same ID fails.
An old receipt can be replayed, but never consumes a later day's gift or
resets the later list. A fresh ID with an obsolete instance/day is rejected.
Application errors are reported explicitly; after a stale-shop error,
close/reopen Shop to reload current offers before trying again.
Each deliberately repeated gold/chest purchase uses a NEW request ID.

Existing databases gain shop state lazily inside accounts.state_json.
No accounts, balances or other progress are reset. No npm packages are needed.
In local mode, the client no longer generates authoritative offers or uses
Today* PlayerPrefs to decide eligibility. Every shop opening reloads the server.
The original remote shop behavior is preserved when Local Bootstrap is off.

SHOP LIMITS
UWP jewel-pack purchases and pending-purchase recovery are available only
after Microsoft Store setup (see UWP STORE AND VUNGLE below). In Editor and
other local platforms they remain disabled. Local package offers are hidden.
No free test jewels, shortened timers, fake payment receipts or debug
currency endpoints are added. The initial tutorial gives 5 jewels, enough
for Battle Royale but not the more expensive shop products.
Daily card prices are also higher than the initial 100 gold.
Gold Doubler, packages, and other ad placements remain unimplemented.
Amazon Appstore jewel purchases are available only after Amazon RVS setup;
Amazon package purchases remain disabled. Old shop_purchase/shop_repurchase
claims are not accepted.

SHOP TEST LOOP
1. Stop Play Mode and the old server, then restart:
     node .\Server\bootstrap-server.cjs
2. Start from the login scene and finish the tutorial if needed.
3. Open Shop: verify five daily card offers and no shop_getshopinfo error.
4. Claim the free gift; close/reopen Shop and verify it cannot be claimed
   again. Verify jewels were not cleared and balances match after relogin.
5. With enough saved jewels, buy gold (especially product 500001), then buy
   a daily card offer using gold. That offer should become sold out.
6. Buy a shop chest: rewards appear immediately, with lobby slots unchanged.
7. Pay for refresh if affordable: verify new list instance/unbought offers,
   unchanged daily deadline and no second free claim.
8. Restart server/client: verify balances, cards, offers and claim flags persist.
9. At 00:00 UTC, verify new daily offers and another free claim become available.
Automated tests use temporary SQLite accounts/funds and a controlled clock
to exercise expensive purchases and midnight without editing your real DB.
They cover exact amounts, tier probability boundaries, stale requests,
sold-out checks, duplicate receipts, account isolation, restart and rollback.

DAILY QUESTS AND ACHIEVEMENTS
Implemented APIs: quest_daily, quest_complete, achievement_list and
achievement_complete. Tutorial completion and a valid session are required.
Rules/rewards come from active Category 1/2 rows of JSONQuestTable and
JSONQuestRewardTable. Inactive boss/clan/invitation tasks stay unavailable.
The server validates supported event/reward types at startup.
Daily Quest and Achievement rewards use their original gold/jewel types
and amounts. The earlier 1 jewel = 50 gold conversion has been reversed.
Daily login grants 1 jewel; claiming all five other daily quests grants
9 jewels. The other active dailies keep their original gold rewards.
Achievements grant the original per-step jewel amounts.
JSONQuestRewardTable drives both client icons/amounts and server grants.
If a reward has multiple entries, all are credited atomically;
the local client synchronizes both balances, not just curMoney.

PREMIUM JEWEL POLICY
Original free jewel sources are restored: tutorial completion (5), daily
login/meta-quest, achievements, level-ups (2 per crossed level) and the
original chest rolls. Clan attendance's original 1-jewel reward at 30
members is restored in the table, but no clan backend is implemented yet.
Entering BR costs 1 jewel; rank 1 receives 2, rank 2 receives 1, other ranks
receive 0. These payouts are NOT capped to the fee or converted to gold.
Thus a BR winner can still earn a net 1 jewel. Quitting keeps the fee spent.
Other gold/card rewards and jewel spending prices stay unchanged.
Original IAP tables remain unchanged. UWP maps six jewel packs separately
and grants only after Microsoft confirms server-side consumption, never
from a client-supplied receipt, amount or purchase-success flag.
New accounts start at 0 jewels and receive 5 on tutorial nickname completion.
The fixed 5-jewel mailbox bonus has been removed. Welcome chest 304001 now
uses its normal 2% chance for 1 jewel, not a guaranteed five.
Direct mail jewel attachments remain unsupported. UWP's two optional ad
placements grant gold or timer reduction, not extra diamonds.
The approved Rare-card Min/Max corrections for league chests remain intact.
Restart server and relaunch the game from startup to refresh cached tables.
Versions: QuestReward/Common/UserLevel/ClanAttendReward=3, Chest=4.
During this restoration, the owner explicitly requested a fresh test start:
the old local game.sqlite test database was removed, clearing accounts,
sessions, balances, battle/claim receipts, quest progress, rankings, league
settlements, mailbox records and purchase state together. No compensation
or migration is applied. Stop Unity Play Mode before restarting; use
Tools/HeroPocket/Clear Client PlayerPrefs to clear the client guest identity
and guide flags too, then launch the startup scene for a fresh tutorial.
For normal restarts afterward, do not delete the database.
Automated tests fund isolated temporary
accounts directly to exercise paid flows; no funding API exists in the game.

DAILY QUESTS
All six active daily quests are available, not a random selection:
  Login/activity once: 10100001.
  Win 3 Smash&Grab matches: 10200001.
  Win 3 Defense matches: 10300001.
  Win 1 Battle Royale (rank 1 only): 10400001.
  Open 3 chests: 11000001.
  Claim rewards for 5 daily quests: 11200001.
Reset is 00:00 UTC, matching the local shop (07:00 Vietnam time).
Daily progress and claim flags reset; lifetime achievements do not.
The completion meta-quest counts successful reward claims, not merely
objectives that reached their targets. Retrying a claim never increments it.
After claiming the five other rewards, its progress is 5 and it is claimable.
Claiming it makes the completed-quest count 6; it remains claimed for the day.
Daily rewards expire unclaimed at the next UTC midnight.

ACHIEVEMENTS (16 ACTIVE FAMILIES)
  100: consecutive UTC login/activity days (selected reconstruction policy).
  200/300/400: victories in Smash&Grab/Defense/BR.
  210: gems picked up in Smash&Grab, NOT premium account jewels.
  310: individual turret kills in Defense.
  600/610/620: potions picked up, kills, and matches with the player's First Kill.
  630: MVP in team modes.
  700: owned heroes.
  710: number of successful individual skill upgrades.
  720: number of owned heroes currently at 100 or more trophies.
  900/910: actual gold/jewels spent.
  1000: successfully opened chests.
Each family shows its first unclaimed QuestStep. Claiming advances only one
step and does not reset cumulative progress. Several ready milestones can
therefore be claimed in succession. After the final reward, the final valid
step is returned with status 2; the client never looks up a nonexistent step.
Previously claimed steps remain claimed even if streak/current trophies fall.

The login streak advances once per active UTC day, not once per HTTP call.
Successful login, lobby load, quest reads and state-changing actions record
activity; reconnecting repeatedly on the same day does not advance it.
Missing an entire UTC day restarts the streak at 1. A persistent session can
count the new day's activity without forcing the player to restart the app.
This policy does not require a claim each day to maintain the streak.

EVENT SOURCES AND RETRIES
Battle wins and statistics are recorded only when the first result is
accepted for a registered battle, in the same transaction as its rewards.
Defeats may still contribute kills/potions/turrets. Team victories use win=1;
BR victories require battle_rank=1. Team MVP requires mvp=the account GSN.
The existing client already reports total_kill, get_potion, get_jam,
turret_kill and first_kill. Server validates integer counts 0..100000 and
mode consistency. First Kill cannot be reported for a zero-kill result.
Local Smash&Grab now reports cumulative gem pickups rather than gems still
held at the end, so dying/dropping gems does not erase collected progress.
Other counters retain their existing client match-total behavior.
Statistics are saved in the result fingerprint: altered retries are rejected.
Missing statistics on older/API-only requests mean no reported pickups/kills.
Pre-update stored battle receipts remain replayable without granting progress.
No old results are rescored or paid again.
These client-reported statistics are for local bot testing, NOT anti-cheat.

All actual chest opens count: lobby free/play/reward chests, instant shop
chests and the shop daily gift. Unlocking a timer, receiving a locked chest,
buying gold/cards or claiming a quest reward does NOT count as a chest open.
Successful shop payments, skill upgrades, instant chest fees and battle
entry fees count as spending at debit time. Insufficient funds, retries,
reward payouts and grants do not add spending. Gold packs count jewel cost,
not the amount of gold they grant.
Roster/trophy objectives use current owned hero state; other event totals
are durable counters recorded from successful actions.

STORAGE AND API CONTRACT
Progress is stored in accounts.state_json.progress, using the existing
SQLite database; do not delete it. Existing roster and summed skill levels
are recognized on initialization. Unknown historical per-mode wins, pickups,
chest opens, spend and login streak are NOT invented or backfilled.
Old accounts begin event counters at zero and a one-day streak.
Account balances, heroes, chest slots, shop state and ranking are retained.

quest_daily and achievement_list return:
  list: [{ id, progressCnt, status, step (achievements only) }],
  quest_day: yyyy-MM-dd UTC, next_reset: UTC yyyyMMddHHmmss,
  quest_cnt, achievement_cnt: number of currently claimable objectives.
All numeric DTO values are strings. Status is 0=in progress, 1=claimable,
2=claimed (or final achievement reward already claimed).
The local client unwraps list for the original NetQuestInfo/NetAchieveInfo
parsers; remote protocol remains unchanged.
Lobby user_info.quest_cnt and achievement_cnt now reflect claimable rewards.
The quest popup uses the server reset deadline and refreshes after midnight.

Claims require request_id plus id. quest_complete also requires quest_day;
achievement_complete requires expected_step. The client snapshots these at
click time and retains the same ID/parameters for transport retries.
Reward, progress, claim state and saved response commit in one transaction.
The same request returns its receipt after restart; a different payload
under that ID fails. A fresh request cannot claim an old day, skip a step,
repeat a claimed reward or claim before reaching its threshold.
The claim response includes legacy curMoneyType/curMoney/status/curStep and
authoritative curGold/curJewel, progressCnt, counters, quests/achievements
lists and reset metadata. Local UI reloads both lists, including meta-quest
progress and notifications, rather than blindly incrementing cached counts.
After a stale-day/step error, reopen the popup to get current data.

QUEST/ACHIEVEMENT TEST LOOP
1. Restart the server and start the client from the login scene.
2. Open the quest popup: the login quest and login achievement are ready.
3. Claim each once; verify balances and that retries/reopening grant nothing
   extra. The achievement moves to its next valid day threshold.
4. Win 3 matches in each team mode and rank 1 in BR. Verify their daily
   objectives, lifetime win totals and claimable notification counts.
5. Open 3 actual chests (shop/free/reward) and claim the chest quest.
6. Claim the five normal daily rewards, then claim the completion reward.
7. Pick up gems/potions, kill enemies/turrets or earn MVP/First Kill; finish
   the battle and check the associated achievements, including on a defeat.
8. Upgrade skills, buy cards/gold/chests and check upgrade/roster/spend progress.
9. Restart to verify persistence. At 00:00 UTC, dailies reset, cumulative
   achievements remain; consecutive activity days grow the login streak.
Automated tests cover all active achievement steps/rewards, daily meta-quest,
UTC midnight, streak gaps, legacy migration, stale claims/statistics, replay,
account isolation and transaction rollback using temporary test databases.

MAILBOX
Implemented APIs: post_getpostlist, post_read, post_receive, post_postdelete.
Mail supports plain-text English/custom titles and contents, read/unread
state, expiry, notices without gifts and server-owned attachments.
The client cannot send mail, choose its gifts or change their amounts.
This release adds automatic welcome delivery only; there is no public
send-mail endpoint, admin console, bulk sender or friend-to-friend mail.

WELCOME DELIVERY
Each tutorial-complete account gets exactly one welcome-v1 mail:
  Title: Welcome to Hero Pocket!
  Contents: Welcome to Hero Pocket! Thank you for joining us. Please claim
            your gift within 7 days.
  Gifts: 100 gold + one normal chest 304001 with its original jewel roll.
  Expiry: exactly 7 * 24 hours from delivery, in server UTC time.
New accounts get it atomically with tutorial nickname completion.
Existing tutorial-complete accounts get it on their next authenticated
non-login API call after this update (normally check_lobby). Unfinished
tutorial accounts do not get it and cannot use the mailbox APIs.
There is no retroactive expiry from account creation/server release time.
Reading, claiming, deleting, expiry, relogin and restart never resend it.
The unique (gsn, delivery_key) row remains as a durable delivery record.
Welcome delivery itself does not grant gold/cards or modify quest/streak
activity. Opening the lobby refreshes post_cnt without opening any gifts.

CLAIMS AND ATTACHMENTS
Supported attachments: gold (item_type=5), released hero cards (2) and a
chest (3). At most three entries and one chest of count 1 per mail.
Jewel attachments (6), packages and guild points are rejected, not granted.
Chests must be among the existing startup-validated supported chest types/
shop/season prizes. The welcome chest uses the shared chest engine with a
welcome-only rule: Common cards for already-owned heroes only, no Rare,
Epic or Legendary cards and no unlocking a new hero. Common card amounts,
gold amounts/rates and relative eligible hero weights remain unchanged.
The welcome chest uses its original 2% chance for 1 jewel; there is no
fixed 5-jewel bonus. Rolled jewels appear inside item_chest, not as a
separate jewel mail attachment, and commit atomically with the other gifts.
This rule is selected by the server-owned welcome-v1 delivery key, never
by a client field. It applies to existing unclaimed welcome mail as well.
Previously claimed receipts remain unchanged and never grant gifts again.
Other mailbox chests and normal/shop/league chests retain their normal
hero pools, including the possibility of unlocking heroes.
Only the internal server delivery code creates production mail currently.
Future server-controlled campaigns may reuse the same stored format and
validation; never trust attachments supplied by a client.

Reading changes only read state and does not claim gifts. A notice without
gifts can be deleted; a gift mail cannot be deleted before receiving it.
Receiving immediately grants direct gold/cards and opens its chest, without
needing/changing any normal chest slot. The chest keeps its normal drop
tables (except the welcome-only card rule above) but has no timer/payment
because it is an attached gift.
The existing chest sequence displays the rolled chest contents. Direct
100 gold is an additional grant, not a replacement for chest gold.
Final currency and card counts include all direct gifts plus the chest,
regardless of attachment order. Jewel rewards follow each chest's restored
original probabilities and amounts.
Receiving an actual chest counts once toward chest-opening objectives.
Merely delivering/reading mail does not count as a chest opened.
Receiving removes the mail from the visible inbox; notices remain until
deleted/expired. There is no separate claimed-mail history screen.
Reward state, read/claimed/deleted state and mutation receipt commit in one
SQLite transaction; an error rolls back the entire claim.

Each post_read/post_receive/post_postdelete requires request_id and post_seq.
Use the same request ID and payload on transport retry: the server returns
the saved response even after expiry, deletion, claim or restart, without
reapplying the action. Fresh IDs cannot reclaim a received mail.
Changing post_seq/API with an old request ID is rejected. Other accounts
cannot access/read/delete/claim someone else's mail, even with its sequence.
Expiry is enforced server-side: expires_at <= request time is unavailable.
Expired attachments are forfeited, not automatically granted or converted.

LIST AND NOTIFICATIONS
post_getpostlist takes cur_page >= 1 and list_item_cnt=1..100.
Returns total_cnt, post_cnt and post[], newest post_seq first; each row
contains post_seq, locale_id="0", title, contents, send_date, expire_date,
state ("0" unread/"1" read), attachlist[{item_type,item_id,item_cnt}].
Legacy numbers are strings and timestamps are UTC yyyyMMddHHmmss.
post_cnt counts ALL live unclaimed/undeleted mail, not just unread mail.
Thus reading a gift mail keeps its notification until claimed/expired.
Lobby, list and action responses use the server count, not the page length.
The current client shows the newest 100 messages (API supports later pages;
there is no client pagination UI). Local mode refreshes each time Mailbox
opens. The open list also removes expired rows and updates its empty state
and badge locally; the next server request is authoritative.
Remote mailbox behavior is preserved, except shared UI-state cleanup.

MAILBOX TEST LOOP
1. Restart the server without deleting the existing database.
2. Launch from startup, log in and finish tutorial if needed.
3. Open Profile -> Mailbox. Check one English welcome mail and its expiry.
4. Read and close it: gifts should still be pending, with no balance change.
5. Receive: verify 100 extra gold PLUS chest gold/cards and any rolled jewel,
   and unchanged chest slots. Finish the chest display and reopen Mailbox.
6. Restart/relog: the mail must not return or grant another reward.
7. Expired mail cannot be claimed; do not change the real PC clock to test.
Automated tests use temporary databases/mocked dates for exact expiry,
existing-account migration, pagination, ownership, receipts and rollback.
League prizes remain in their separate settlement popup, not this inbox.

PERSISTENCE AND IDENTITIES
SQLite is created automatically at Server\data\game.sqlite.
Do not delete it to restart the server. Stop the server before backing up
the data directory. Runtime data is excluded by Server\.gitignore.
Close and restart the server, then relaunch from the startup scene to verify
the same account, nickname, balances, heroes and chest timer are preserved.
The client RNDGUID is the guest identity. Keep it to keep the same account.
Clearing the local account button creates a different guest identity; it
does not delete the previous account in the database.
Unknown GSNs from the old backend cannot restore old progress: a new local
account is created for this guest identity. A GSN belonging to another local
identity is rejected, not used to impersonate that account.
Guest-only: memberType=1 and memberId=udid. Google/Apple account linking,
membership_switching and external identity verification are not implemented.
For the current test, use Unity Editor with Editor Server Live disabled.
Do not launch the lobby scene directly; login first to obtain a session.
Sessions last 24 hours and survive restarts; only their hashes are stored.

IMPLEMENTED FORM APIS (POST /mph)
check_login: memberType, memberId, udid, optional gsn
check_lobby: gsn, sessionid
ranking_list: gsn, sessionid
ranking_weekly: gsn, sessionid
league_list: gsn, sessionid
league_weekly: gsn, sessionid (oldest unacknowledged frozen season + rewards)
league_rewardclaim: gsn, sessionid, reward_id, request_id
league_ack: gsn, sessionid, season_id, request_id
post_getpostlist: gsn, sessionid, cur_page, list_item_cnt (1..100)
post_read: gsn, sessionid, post_seq, request_id
post_receive: gsn, sessionid, post_seq, request_id
post_postdelete: gsn, sessionid, post_seq, request_id
shop_getshopinfo: gsn, sessionid
shop_buyitem: gsn, sessionid, product_id, shop_instance, request_id
shop_freechest: gsn, sessionid, shop_day, request_id
quest_daily: gsn, sessionid
achievement_list: gsn, sessionid
quest_complete: gsn, sessionid, id, quest_day, request_id
achievement_complete: gsn, sessionid, id, expected_step, request_id
character_getlist: gsn, sessionid, char_id (0 = all owned heroes)
user_nickupdate: gsn, sessionid, nickname (tutorial completion only)
chest_unlock: gsn, sessionid, slot_id=3..6, chest_id, chest_instance, request_id
chest_open: gsn, sessionid, slot_id=1..6, chest_id, chest_instance, request_id,
  nowYN=N (ready chest) or Y (instant reward chest)
character_upgradeskill: gsn, sessionid, char_id, skill_type=0..2,
  expected_level=0..7, request_id
game_entryfee: gsn, sessionid, room_id, mode, play_char_id, map_idx
game_singleresult: same identity fields plus entry_user_cnt=1, win,
  battle_rank, mvp (gsn of MVP, or "0")
  Optional legacy match statistics: total_kill, get_potion, get_jam,
  turret_kill (nonnegative integers), first_kill (GSN, empty/"0" for none).
Both URL-encoded forms and multipart WWWForm fields are accepted.
characterList contains JSON strings as required by NetHeroInfo.set_data.
UTC timestamps use yyyyMMddHHmmss. Lobby mode timers refresh server-side.
Application errors use HTTP 200 with result="error" and a numeric string
data.code because the client int.Parse()s error codes. Error details are
logged by the server; unsupported operations do not return fake success.
Codes: 4000 invalid input, 4001 invalid session/identity, 4003 unavailable
operation, 4004 missing character or unimplemented API, 5000 server failure.
Malformed/oversized HTTP forms and internal failures use HTTP error statuses.
Gold Doubler, paid packages/nickname changes, social login and multiplayer
remain out of scope. Optional UWP Store/Vungle APIs are documented below.

The server serves the existing Assets\Resources\jsonres files without copying
or modifying them. It loads config and tables into memory at startup.
Restart the server after editing bootstrap-config.json or a table.
Increase the corresponding tabledata version when publishing a changed table.
maintenance and tabledata are objects in the editable config; the server
serializes them into JSON strings in the HTTP response for the legacy client.
version is the minimum app version, currently 1.1.4, not a table version.
Disable "Use Local Bootstrap" to restore the original remote download URLs.

PUBLIC INTERNET DEVELOPMENT TEST (HOST 160.250.186.219)
The test server is served over direct HTTP on TCP 38500. Build the client
with Development Build enabled and set LogoMgr's Local Bootstrap Url to:
   http://160.250.186.219:38500
HTTP is for Editor/Development Build testing only; do not publish a release
build with this URL. This guest/bot backend trusts client-reported outcomes,
has no production account authentication or Socket.IO service, and is only
for disposable public tests. Do not use real accounts, purchases or secrets.
The VPS service must bind HOST=0.0.0.0 and advertise
PUBLIC_API_URL=http://160.250.186.219:38500/mph. Permit inbound TCP 38500
in the hosting provider firewall. Keep the database separate from production.

PHONE ON THE SAME LAN (optional)
1. Use the PC's LAN IPv4 address, not 127.0.0.1.
2. Set api and host in bootstrap-config.json to that address.
3. In the same PowerShell window, run:
     $env:HOST = '0.0.0.0'
     node .\Server\bootstrap-server.cjs
4. Set LogoMgr's Local Bootstrap Url to http://<PC-LAN-IP>:38500
5. Allow TCP 38500 on the private network if Windows Firewall prompts.
6. Verify the config URL in the phone browser before launching the game.
Player Settings permit HTTP in Editor and Development Builds only.
Enable Development Build when testing a phone build over local HTTP.
Release builds still require HTTPS (and later WSS for realtime).
Do not expose this development server to the public Internet. Guest identity
is a locally stored identifier, not production-grade account authentication.
Socket.IO port 38800 is only advertised; no realtime service is running yet.

DEPLOYMENT PREPARATION (HOST 160.250.186.219)
The server can now advertise deployment endpoints through environment variables
without changing the local development config:
   PUBLIC_API_URL     API URL placed in /mph_config.json
   PUBLIC_SOCKET_HOST host placed in /mph_config.json (Socket.IO is not running)
   PUBLIC_SOCKET_PORT port placed in /mph_config.json (Socket.IO is not running)
   HOST               address Node binds to; use 127.0.0.1 behind a proxy
   PORT               Node listen port; default 38500

For a temporary development-build smoke test only, bind the API directly to
the public interface (allow TCP 38500 only as needed):
   HOST=0.0.0.0 PORT=38500 PUBLIC_API_URL=http://160.250.186.219:38500/mph node Server/bootstrap-server.cjs
Use http://160.250.186.219:38500 as LogoMgr's Local Bootstrap Url. Release
mobile builds require HTTPS; do not use this direct-HTTP setup for release.

For release builds, point a domain's HTTPS reverse proxy to Node on
127.0.0.1:38500, then start Node with:
   HOST=127.0.0.1 PORT=38500 PUBLIC_API_URL=https://<your-domain>/mph node Server/bootstrap-server.cjs
Set LogoMgr's Local Bootstrap Url to https://<your-domain> in the client
build. Allow inbound 80/443 for the proxy and keep Node's port private. The
server needs Node.js 22.13+ and access to this project's Assets/Resources
files; persist Server/data/game.sqlite and back it up. Run as a dedicated
unprivileged service account and keep store/callback secrets out of source.

IMPORTANT: this reconstructed backend uses locally stored guest identifiers,
does not implement realtime Socket.IO, and is not production-grade account or
anti-cheat infrastructure. Publishing the IP does not make it safe for public
players or real-money transactions. Restrict access to a test audience until
authentication, rate limiting, backups, monitoring and security review exist.

Validation from the project root:
  node --test .\Server\bootstrap-server.test.cjs .\Server\game-api.test.cjs .\Server\monetization.test.cjs

UWP STORE AND VUNGLE (WINDOWS PC)
Status: integration code and automated accounting tests, NOT a certified
Store release. Default configuration deliberately disables real payments
and rewarded video until real products, credentials and placements exist.
No universal Vungle UWP test ID is invented. Use your own Windows app and
placement IDs with test mode enabled in Vungle/Liftoff's dashboard.
The Editor does not simulate purchases or completed rewarded video.

Unity Purchasing 5 removed Windows Store support. This UWP integration uses
Windows.Services.Store directly, guarded by UNITY_WSA/ENABLE_WINMD_SUPPORT.
Android builds use the Amazon Appstore bridge and verified receipt route;
iOS retains the existing Unity IAP path. Use Local Bootstrap for the new
Node backend, including UWP and Amazon receipt testing.

PARTNER CENTER SETUP
1. Open your existing Windows app in Partner Center -> Add-ons -> New add-on.
2. Create SIX STORE-MANAGED consumables (not durable, subscription, or
   developer-managed consumable). Set the Store quantity to ONE per purchase:
   one Store unit represents one PACK, not one diamond.
   Suggested developer Product IDs (offer tokens):
     heropocket.diamonds30   -> shop 410001 ->   30 diamonds
     heropocket.diamonds80   -> shop 410002 ->   80 diamonds
     heropocket.diamonds170  -> shop 410003 ->  170 diamonds
     heropocket.diamonds350  -> shop 410004 ->  350 diamonds
     heropocket.diamonds900  -> shop 410005 ->  900 diamonds
     heropocket.diamonds1850 -> shop 410006 -> 1850 diamonds
   Set names, descriptions, markets and prices in Partner Center. Product
   type cannot simply be switched later; choose the correct consumable type.
3. Submit/publish the app and add-ons using Microsoft's hidden/test audience
   guidance. An unsubmitted add-on or unassociated sideload alone is not a
   working Store test. Real Store purchase dialogs may charge real money:
   do not assume Development Build or Vungle test mode makes IAP free.
4. Copy each add-on's 12-character STORE ID (e.g. starts with 9...), NOT its
   offer token, into storeId in Assets\Resources\UwpMonetization.json.
   Offer tokens are setup labels; runtime lookup uses the Store ID.
   Restart Node and rebuild UWP after changing this shared public config.
5. Associate the exported Visual Studio UWP project with the SAME app:
   Project -> Store/Publish -> Associate App with the Store.
   Package identity and publisher must match Partner Center.

MICROSOFT SERVER AUTHENTICATION
Server verification requires a Microsoft Entra application linked to this
app's Store services in Partner Center (Product settings/Store services).
Follow Microsoft's "Manage product entitlements from a service" instructions:
  https://learn.microsoft.com/en-us/windows/uwp/monetize/view-and-grant-products-from-a-service
Configure ONLY on the Node host, using your normal secret management:
  MS_STORE_TENANT_ID
  MS_STORE_CLIENT_ID
  MS_STORE_CLIENT_SECRET
Do not put the secret in Unity resources, source control, logs or chat.
Missing all three disables IAP; partially configured credentials fail startup.
The service obtains separate OAuth audience tokens for Collections ID
creation and Store API access. Only the ID-creation ticket reaches UWP;
the Store API access token stays on the server. Sensitive Store responses
are redacted from the Unity HTTP logger.

AMAZON APPSTORE RECEIPT VERIFICATION
The Android Gradle template includes amazon-appstore-sdk 3.0.9. In the
Amazon developer console, create the six active jewel consumables with the
same SKUs as ShopTable (heroes.dia1.aos through heroes.dia6.aos). Configure
the app's Amazon shared secret only on the Node host:
   AMAZON_IAP_SHARED_SECRET
The Android client sends receipt ID, SKU and shop ID to amazon_purchase.
It also sends the Appstore user ID returned by getUserData. Both production
and sandbox RVS require that user ID. Set AMAZON_IAP_RVS_MODE=sandbox while
testing with Amazon App Tester. From the project root on a test host, add
--env-file=Server/amazon-sandbox.env to the existing Node startup command:
   node --env-file=Server/amazon-sandbox.env Server/bootstrap-server.cjs
Keep the existing HOST, PORT and PUBLIC_API_URL settings for the test host.
Already-set environment variables take precedence over this file, so remove
or update conflicting Amazon IAP settings in the test service before restarting.
Never load this file on a production server or store a real Shared Key in it.
Production uses the same verifyReceiptId path without the /sandbox segment.
For Live App Testing (LAT) and Appstore release builds, deploy the updated
server and use production RVS. On a systemd host, create a private env file
(for example /etc/heropocket-iap.env, owned by root with mode 0600) containing:
   AMAZON_IAP_RVS_MODE=production
   AMAZON_IAP_SHARED_SECRET=<real Shared Key from Amazon Developer Console>
In the existing service drop-in, replace the sandbox EnvironmentFile line
with EnvironmentFile=/etc/heropocket-iap.env and restart the service. Check
that the APK points to the HTTPS API served by that instance. Keep the
production env file out of Git and keep App Tester on a separate sandbox
service if both are needed at once.
The server checks the verified SKU/type and cancel state, then grants the
table-defined jewel amount once per receipt.
The client calls Amazon notifyFulfillment(FULFILLED) only after that grant.
For RVS HTTP rejections, check the backend log for
`Amazon RVS verification failed`. It reports the HTTP status and whether the
receipt ID contains a slash, without exposing the request URL or identifiers.
If the server is unreachable, the receipt remains unfulfilled and is retried
through Amazon Purchase Updates when the shop is reopened. Never put the
shared secret in Unity resources, source control, logs or chat.
Only category-4 jewel packs are enabled; package/remainder products are
blocked before checkout until their server-side reward logic is implemented.

PURCHASE/RECOVERY CONTRACT
store_catalog: gsn, sessionid -> flags and configured products.
store_begin: gsn, sessionid, product_id -> durable per-account pending intent.
store_pending: gsn, sessionid -> unfinished intents.
store_identity: gsn, sessionid -> ticket for GetCustomerCollectionsIdAsync.
store_redeem: gsn, sessionid, intent_id, user_key -> authoritative jewel balance.
amazon_purchase: gsn, sessionid, product_id, sku, receipt_id, user_id ->
   verified, idempotent Amazon jewel grant. user_id is required by sandbox RVS.
All require completed tutorial. Requests use existing POST /mph authentication.
Store UI calls run on the Windows UI thread. Prices come from
StoreProduct.Price.FormattedPrice; no Android dollar price is shown on UWP.
The client checks remaining pack balance before requesting another purchase.
Opening the jewel shop recovers pending intents and remaining purchased packs.
Keep the same game guest identity AND Microsoft Store account for recovery.
Do not clear PlayerPrefs or delete SQLite while purchases are pending.

The server persists trackingId BEFORE calling the v8 Collections consume
API with removeQuantity=1, validates confirmation, then atomically saves
diamonds and the grant marker. After timeout/crash it reuses that SAME ID;
it never generates a fresh ID to retry an uncertain fulfillment. Currency
is reloaded after the remote call so concurrent rewards are not overwritten.
Fulfillment-started intents are retried before another purchase dialog.
No client ReportConsumableFulfillmentAsync call is used: the server consumes.
The Store balance tracks PACKS; the game database tracks credited diamonds.

VUNGLE REWARDED VIDEO
Existing plugin: Unity 6.11.0.1 / Windows SDK assembly 6.11.0.0 (legacy).
Having these binaries or dashboard placements does not prove current ad
inventory/support. Actual initialization, playback and S2S delivery must
be tested on Windows; confirm legacy Windows support with Liftoff if needed.
No interstitial, free chest bypass or chest-item doubling is enabled.

In Assets\Resources\UwpMonetization.json configure:
  vungleAppId          = your WINDOWS app ID
  chestTimePlacement   = rewarded placement for timer reduction
  battleDoublePlacement = DIFFERENT rewarded placement for result gold
  childDirected       = the correct audience setting for your app
  privacyConfigured   = true ONLY after completing privacy/consent setup
Review Store age rating, privacy policy, audience/COPPA and any required
CMP/consent requirements before enabling ads. This integration requests
denied GDPR/CCPA personalization and hardware-ID privacy; these defaults
are NOT a substitute for a compliant consent/privacy flow for your markets.
GDPR status is applied when the legacy Windows SDK initializes.

Set VUNGLE_CALLBACK_SECRET on Node to a random secret of at least 32
characters, generated and stored server-side. NEVER put this in Unity.
In Vungle configure a SERVER reward callback for COMPLETED rewarded views
only, not impressions, clicks or ad-close events. The HTTP contract is:
  GET https://<callback-host>/vungle/reward
    ?key=<secret>&user=<SDK-userTag>&txid=<Vungle-transaction-ID>&placement=<placement-ID>
Use the dashboard's actual user-ID and transaction-ID substitution macros,
not these angle-bracket placeholders. SDK userTag is the server's ad_intent
UUID, NOT the player's GSN. Set the placement parameter to the correct
placement's ID (or its verified dashboard macro) for each rewarded placement.
Confirm your Windows placement supports these substitutions and completion
callbacks; if it does not, leave ads disabled rather than grant on client trust.
The endpoint authenticates the callback's secret, placement, expiry and
globally unique transaction ID. Configure your HTTPS proxy to suppress query
strings in logs, since this callback uses a secret URL. Never disclose it.
Do not expose /mph or the development backend publicly to enable callbacks.
Expose ONLY this callback route through an authenticated-secret HTTPS ingress.

ad_prepare: gsn, sessionid, kind:
  chest_time: slot_id=3..6, chest_instance
  battle_double: room_id of a completed battle less than 24 hours old
Returns ad_intent + placement; intent lasts 15 minutes and is target-bound.
ad_claim: gsn, sessionid, ad_intent -> pending/granted + current balances/chests.
There is intentionally NO client "completed=true" endpoint to mint rewards.
Only the verified S2S callback grants; duplicate callbacks are safe. A valid
callback also persists rewards if the client closes or the claim reply is lost.
Timer reduction: once per chest instance, 60 minutes from the table, clamped
at current UTC time; no effect on another/replaced/opened chest.
Battle reward: one extra copy of saved winGold+mvpGold+boosterGold, NOT EXP,
trophies, entry-fee/jewel payout, level-up rewards or another chest.
The legacy desktop auto-success ad shortcut is not used for the local backend.
UWP listens to onAdFinishedEvent.IsCompletedView, not the mobile-only
onAdRewardedEvent. Skipped/failed/unavailable videos never grant locally.

LOCAL UWP BUILD/TEST
1. Keep Node running on this PC. Keep Use Local Bootstrap enabled in LogoMgr
   and its URL at http://127.0.0.1:38500. Keep the matching api URL in the
   server's bootstrap-config.json. Start from the startup scene, not lobby.
2. Unity Build Profiles -> Universal Windows Platform:
   target PC/x64, IL2CPP, XAML build type for the existing legacy Vungle
   bridge, Windows SDK installed (e.g. 10.0.22621.0), Development Build.
   Use .NET Framework API compatibility for WinRT/legacy plugin support.
3. Enable InternetClient and, for local/LAN testing, PrivateNetworkClientServer
   capabilities. Verify VungleSDK and VungleSDKProxy winmd imports target
   UWP, and the proxy DLL is the Editor placeholder (not a shipped fake).
   Existing Tools -> Vungle -> Prepare Windows Plugins configures these.
4. Export to a NEW build folder. In Visual Studio, associate with Store, use
   a matching development certificate, build/install x64 and run.
5. UWP loopback is restricted. For development only, after installing find
   your app's actual PackageFamilyName via Get-AppxPackage, then run an
   elevated PowerShell:
     CheckNetIsolation.exe LoopbackExempt -a -n="<PackageFamilyName>"
   Remove the exception after testing with -d instead of -a.
   This is NOT a Store deployment solution. Public release requires HTTPS
   backend URLs and appropriate production authentication, not localhost.
6. Verify login/tutorial/lobby first. With config still blank, buying should
   explicitly report unavailable and never open a fake Store purchase.
7. After Store setup, check localized prices, cancel a purchase, complete a
   purchase, reconnect after a failed redemption, restart client/server and
   reopen Shop. Exactly one pack must be credited per Store unit consumed.
8. For real rewarded tests, Vungle's servers cannot call 127.0.0.1. Provide
   an HTTPS ingress to ONLY /vungle/reward while keeping gameplay local.
   Enable your dashboard's test mode and verify actual Windows callbacks.
   Test complete/skip/no-fill, duplicate callback, closing after playback,
   exactly one timer cut per chest and one extra gold reward per battle.

RELEASE GATES STILL REQUIRED
Actual signed UWP export/install, real Store products/account association,
Vungle Windows playback/S2S verification and Store certification are not
replaced by C# compilation or backend unit tests.
This guest-only bot server is still a DEVELOPMENT backend. Before public
monetized release, add secure recoverable accounts/HTTPS and financial
operations including refund/chargeback reconciliation and support tooling.
Do not market this integration as a production-ready payment service yet.

Microsoft references:
  https://learn.microsoft.com/en-us/windows/uwp/monetize/enable-consumable-add-on-purchases
  https://learn.microsoft.com/en-us/uwp/api/windows.services.store.storeproduct.productkind
  https://learn.microsoft.com/en-us/gaming/gdk/docs/store/commerce/service-to-service/microsoft-store-apis/xstore-v8-consume

Stop the server with Ctrl+C in its terminal.
