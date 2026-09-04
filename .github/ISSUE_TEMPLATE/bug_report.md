---
name: Bug report
about: Something in the template itself is wrong or does not work
labels: bug
---

**What happened**

**What you expected**

**Reproduction**

```sh
# the commands you ran
```

**Output of `npm run doctor`**

```
# this covers the setup: Node, the SDK, the manifest, the adapter, the licence
```

**Output of `npm run smoke`**

```
# paste it — this tells us whether the plugin booted and handshaked at all
```

**Your `soundbase` block from `package.json`**

```json
```

That block records which template release you started from and which contract
version it targets. Without it we are guessing.
