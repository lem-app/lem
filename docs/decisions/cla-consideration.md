# Contributor licence agreement: consideration

**Date:** 2026-08-01
**Status:** undecided — requires maintainer decision and legal counsel
**Context:** [#47](https://github.com/lem-app/lem/issues/47); [`../positioning.md`](../positioning.md) §"AGPL does less than the README implies"

This document exists so the decision can be made deliberately. It does not make it, and
nothing here is legal advice.

---

## The problem

Relicensing Lem later would require permission from every contributor who holds copyright in
the code, because under the project's current DCO arrangement contributors keep their
copyright. That permission costs nothing to secure today and grows more expensive with every
outside contribution merged. Both of the closest comparables in this space — [NetBird](https://github.com/netbirdio/netbird)
and [Pangolin](https://github.com/fosrl/pangolin) — hold contributor licence agreements.
VideoLAN, which held none, spent roughly a year relicensing VLC, had to track down more than
230 developers, and still dropped about 25 modules where consent could not be obtained.
Lem has few outside contributors right now, so whatever the answer is, this is the cheapest it
will ever be to act on it.

---

## Options

### (a) No CLA — the status quo

Contributors keep their copyright. Nothing is asked of them beyond the DCO sign-off already
required, and inbound code is licensed AGPL-3.0-or-later, the same as outbound.

- **For:** maximum contributor goodwill and the lowest possible barrier to a first PR. Nobody
  has to read a legal agreement to fix a typo. The project cannot rug-pull its own community,
  and can say so credibly.
- **Against:** relicensing is effectively foreclosed. Not literally impossible — VLC proves it
  can be done — but the VLC numbers are what "possible" costs. Any future move (a licence
  change, a permissive client split like NetBird's, an exception for an app store) needs
  unanimous consent or a rewrite of the affected code.

### (b) A CLA

Two distinct instruments get called "a CLA", and the difference matters:

- **Copyright assignment.** The contributor transfers ownership of the contribution to the
  project. The project becomes the copyright holder and can do anything an owner can. This is
  the rarer and more contentious form; the FSF uses it, and Oracle's ownership of MySQL is the
  cautionary example people reach for.
- **Licence grant.** The contributor *keeps* copyright and grants the project a broad,
  irrevocable copyright and patent licence, including the right to sublicense. That
  sublicensing right is what makes a future relicense possible without re-contacting anyone.
  This is what most projects use — the [Apache ICLA](https://www.apache.org/licenses/icla.pdf)
  is the standard template, and NetBird's and Pangolin's are of this shape.

The friction is real and should be named plainly: **every drive-by contributor must sign before
their PR can merge.** In practice that means a bot blocks the merge until a signature is on
file, so someone fixing a one-line typo is asked to enter into a legal agreement first. Projects
that adopt a CLA see a measurable drop-off in casual contributions, and a subset of
contributors decline on principle — Drew DeVault's ["Don't sign a
CLA"](https://drewdevault.com/blog/Dont-sign-a-CLA/) is the canonical statement of that
position: a licence-grant CLA hands the project the ability to relicense *"up to and including
making it entirely closed source"*, and asking for that is asking for trust that has been
abused before.

A middle path exists. [GitLab uses DCO for its open core and a CLA only for the proprietary
directories](https://about.gitlab.com/community/contribute/dco-cla/), which confines the
friction to the code where it buys something.

### (c) A DCO — what Lem has today

**A DCO does not preserve relicensing rights.** It is worth stating flatly because the two are
routinely conflated. The [Developer Certificate of Origin](https://developercertificate.org/)
is a certification of *provenance*: by signing off, a contributor asserts that they wrote the
code or otherwise have the right to submit it under the project's licence. It grants the
project nothing beyond the inbound licence — here, AGPL-3.0-or-later. Once a contributor's code
merges under DCO, that code cannot be relicensed without their permission.

So (c) is not a third answer to this problem. It is option (a) with a provenance record
attached, and Lem already has it.

---

## A related inconsistency to resolve either way

[`AGPL-FAQ.md`](../../AGPL-FAQ.md) currently makes two promises that cannot both hold for
contributed code under DCO:

- *"Can Lem change the license in the future?"* — "It's very difficult… **This protects the
  community** from future 'rug pulls' or license changes."
- *"Do you offer commercial licenses?"* — "**Yes!** … Proprietary/dual-licensing".

Dual-licensing requires rights the project does not hold in code it did not write. Whichever
way the CLA question goes, that text needs reconciling.

---

## Out of scope for this document

No CLA text is committed here, and no CLA bot, status check, or PR-template signature
requirement is added. Preparing the decision is the deliverable; executing it is not. If a CLA
is adopted, the text itself should come from counsel, not from a template pasted out of another
project's repository.

---

**Status: undecided — requires maintainer decision and legal counsel.**
