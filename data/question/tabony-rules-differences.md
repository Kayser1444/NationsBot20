# Tabony Games — Rules Differences

Source: https://games.tabony.net/forum/viewtopic.php?p=4#p4
Author: Logitude (Tabony site owner)
Captured: 2026-10-16T05:55:44.702Z

This is an implementation note, not official board-game errata. The Markdown is a review copy of the bundled JSON seed; Railway refreshes its separate JSON cache.

## Known differences from the official rules

### tabony-rules-differences/official-1

Discarding turmoil and end-of-round effects are resolved simultaneously. (The rules as written would have you check for most/least stability/military after every change in game state, but when discarding turmoil and resolving end-of-round effects, the rules don't specify an order. This implementation resolves all of those effects simultaneously. In other words, this implementation does not check for stability and military requirements during those phases. This only matters for a few cards that would have you remove them under certain conditions.)

### tabony-rules-differences/official-2

Cards with effects that last "this round" or "until end of round" have their effects removed when replaced. Officially, the card text overrides the rules, and these effects should continue. The specific cards with this property are: Old Uppsala Shwedagon Pagoda Versailles Sheba Roman Republic

## Known differences from MaBiWeb's rules implementation

### tabony-rules-differences/mabiweb-1

Private architects are tied to the cards that provide them. They don't go into one pool. You decide where to use them from. Unused private architects on replaced cards are lost.

### tabony-rules-differences/mabiweb-2

MaBiWeb had a bug in the production phase, where one type of resource would be produced or consumed at a time, such that positive production of one type of resource might not be available to cover consumption of another. This site implements the correct rule, which is that all positive production happens before all negative production.

### tabony-rules-differences/mabiweb-3

Massimo (the author of MaBiWeb) and I both misunderstood the FAQ entry on Axumite Kingdom. On MaBiWeb, the markers would persist even after Axumite Kingdom was replaced. That was a bug, which has now been fixed on this site. The markers now get removed if you replace Axumite Kingdom.

### tabony-rules-differences/mabiweb-4

No separation of decks, like advanced, expert, and dynasties.

### tabony-rules-differences/mabiweb-5

No base game. Always Dynasties, all the time.

### tabony-rules-differences/mabiweb-6

No A-sides. "It's time to play B-sides."

## Historical context (supplied by the bot owner)

MaBiWeb was an earlier Nations implementation by another creator and no longer exists. The post identifies its author as Massimo. Mention comparisons only when relevant, and distinguish historical implementation behavior from official rules.
