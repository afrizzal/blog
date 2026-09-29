---
title: 'Removing a container guarantees its process is gone, not its mount'
description: 'A jailed shell on a shared host silently bind-mounted a Docker container''s overlay filesystem into its own view. Three straight docker rm -f runs still found the mount busy, because the thing holding it open was never the container the deploy script could see.'
category: 'Systems & Performance'
pubDate: 2026-09-29
tags: ['architecture', 'reliability']
draft: false
---

A deploy pipeline failed twice on the same afternoon, on its first runs after a hardening pass. The first failure cost nothing — the old container kept serving traffic while a one-line fix landed. The second failure took the site down, and it survived four attempted fixes before the fifth one held; the outage lasted about twenty-three minutes. Nothing in the deploy script was wrong on its own terms. The thing holding the old container's filesystem open wasn't the container — it was a piece of the host nobody had told the deploy script existed.

## The first failure looked like an incomplete image

The pipeline bakes the Prisma CLI into the production image so migrations never fetch a package from npm at deploy time. The first run that day failed at `prisma migrate deploy` with a missing-module error: `@prisma/engines` had been copied into the image, but not its dependency `@prisma/debug`. The fix was to copy the whole `@prisma` directory instead of hand-picking one package inside it. The old container kept answering requests the entire time, because the failure happened before the recreate step ever touched it. That detail matters only because the next failure, minutes later, happened after the recreate step had already touched the old container, and wasn't recoverable the same way.

## The second failure stopped halfway through a recreate

With the image fixed, the next run stopped the old container and tried to remove it before starting the new one — an ordinary recreate. It died mid-remove, with an error of this shape (IDs elided):

```text
Error response from daemon: driver "overlay2" failed to remove root filesystem for <container-id>: unlinkat /var/lib/docker/overlay2/<id>/merged: device or resource busy
```

The old container had already been stopped. Its `merged` directory — the unified view Docker's overlay2 driver builds by layering the image's read-only files under the container's writable layer, and the directory it treats as the container's actual mount point — could not be removed. The site went down with a 503: the old container was stopped, and the recreate that should have replaced it was blocked.

## Filtering by status guessed the wrong lever

The first recovery attempt matched containers in `dead` or `removing` status, lazy-unmounted their `merged` directories, force-removed them, and retried `up -d`. It matched nothing — the stopped container was in neither state — so nothing was unmounted and the retry hit the same wall. The escalation dropped the status filter: lazy-unmount and force-remove every app container by name, print `fuser` output for diagnosis, and if `up -d` still failed, restart the Docker daemon as a last resort. That failed too. Neither a host-side `umount` of the `merged` path nor a full daemon restart released whatever was holding the directory.

## A private mount namespace was the next suspect

The third attempt named a root cause: the overlay mount had leaked into the private mount namespaces of host services — the commit calls it the httpd/Imunify/CageFS pattern familiar from cPanel hosts. Linux's `mount_namespaces(7)` explains why that would defeat everything tried so far: "Subsequent modifications to the mount list … in either mount namespace will not (by default) affect the mount list seen in the other namespace," unless the mounts belong to a peer group that propagates those events between them. A host-side `umount`, or even a daemon restart, only ever touches the host's copy of the mount table. So the recovery grepped every process's `/proc/*/mountinfo` for the overlay ID, deduplicated the matching processes by mount-namespace ID, and used `nsenter` to lazy-unmount the `merged` path inside each namespace still referencing it. It still unmounted by the `merged` path, though — and that path turned out to be the wrong handle.

## One unmount only pops one layer

That still failed. The next commit theorized a second problem: every failed recreate had remounted the overlay at the same merged path, so roughly six mounts were stacked on top of each other, and a single `umount` only ever pops the topmost one. The corrected version looped: keep grepping `/proc/self/mountinfo` for the overlay ID and unmounting until it stops appearing, bounded at fifteen tries so a genuinely stuck mount stops and prints a warning instead of spinning forever. It also stopped throwing away `umount`'s stderr — and that turned out to be the change that mattered.

## The overlay was still mounted, just not at the merged path

The looped version's run printed `umount: merged: not mounted` — while the overlay ID was still sitting in the host's own `/proc/self/mountinfo`. That overturned an assumption baked into every attempt so far, stacking included: that `merged` was itself something you could `umount`. On this host it wasn't. The fix commit's diagnosis was that it had become the *source* of a bind mount living somewhere else, and that `unlinkat` gives `EBUSY` for the root of any active mount, not only for a mountpoint sitting at that exact path — a mechanism the commit asserted rather than tested.

The deployment doc's root-cause note names the somewhere else: the host's jailed-shell layer, cPanel's `virtfs`, had bind-mounted the container's `merged` directory into one account's jail at `/home/virtfs/<account>/var/lib/docker/overlay2/<id>/merged`. That mount sat in a mount table the deploy script could read the whole time, at a path that neither Docker nor any `umount` of `merged` would ever address.

The working version stopped trying to unmount `merged` directly and instead unmounted every mountpoint whose mountinfo line *referenced* the overlay ID — host namespace and private namespaces alike — logging each matching line first, so the next failure, if there was one, would show exactly what it found instead of just failing again with no more information than the last attempt had. The manual equivalent, as the deployment doc records it:

```text
grep <overlay-id> /proc/self/mountinfo
umount -l <mountpoint — column 5 of the matching line>
docker rm -f <container>
docker compose up -d
```

## The same pin came back for the database within the hour

Later that afternoon, virtfs pinned the Postgres container's overlay the same way — a second incident, roughly seven minutes long. That's why the recovery stopped being an app-specific block and became a `recover()` function that covers every non-running project container, app or db, and also guards the `up -d db` step that runs before the pre-migration dump. The deployment doc lists the preventive options next to the recovery as things to consider: disable the jailed shell for that account, or exclude `/var/lib/docker` from virtfs entirely. The recovery treats the symptom whenever it recurs; only a host configuration change would remove the cause.

## A container and its filesystem answer to different owners

A container's lifecycle and a filesystem's lifecycle are two different objects with two different owners, and Docker only fully controls the second one on a host where nothing else is allowed to look inside `/var/lib/docker`. On a box you don't fully own — shared hosting, a jailed shell, any platform that wraps its own sandboxing around your containers — something else can hold a reference to a directory Docker considers private, through a mechanism Docker's own tooling has no way to see and no vocabulary to describe. `docker rm -f` guarantees the container's process is gone. It says nothing about who else was standing on the ground underneath it.

On a host you share, the thing keeping a resource busy might not be anything Docker can see at all — so the first question after `EBUSY` is never "why won't it unmount," it's "who else has this mounted."

---

## Sources

- Docker Docs — *OverlayFS storage driver* (the `merged` directory is the unified view of the lower and upper layers and "effectively the containers mount point"). Retrieved 2026-09-29. <https://docs.docker.com/engine/storage/drivers/overlayfs-driver/>
- Linux man-pages — *mount_namespaces(7)* (mount and unmount events in one mount namespace do not, by default, affect the mount list of another, except through shared-subtree propagation between peer groups). Retrieved 2026-09-29. <https://man7.org/linux/man-pages/man7/mount_namespaces.7.html>
