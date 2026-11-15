# Native Nations client

`match.html` is the native canvas renderer from Charles J. Tabony's
`Logitude/TabonyGames` project, copied from the local `nations-server` checkout
on 2026-11-15. It is used under the accompanying MIT licence.

Original SHA256:
`1e0f7dd66dc495c6162aa2e2080277914f33d8b6d09b97a4378c07a9dcd65e2c`

The template itself is unchanged. `scripts/native_nations.py` renders its content
block with local identity/context. `native-transport.js` adapts its WebSocket
interface to the loopback HTTP engine and replay endpoints; it never opens a
live game connection. The shell provides evaluation controls around the native
renderer. Public images and the pinned Bootstrap stylesheet are cached in the
ignored `.data/nations-native-assets` directory and are not redistributed here.
