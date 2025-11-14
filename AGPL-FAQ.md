# Lem License FAQ

## Table of Contents

- [General Questions](#general-questions)
- [Using Lem](#using-lem)
- [Modifying Lem](#modifying-lem)
- [Distributing Lem](#distributing-lem)
- [Commercial Use](#commercial-use)
- [Contributing](#contributing)

---

## General Questions

### What license is Lem under?

Lem is licensed under the **GNU Affero General Public License v3.0 or later (AGPL-3.0-or-later)**.

This is a strong copyleft license approved by the Open Source Initiative (OSI) and the Free Software Foundation (FSF).

### Why did you choose AGPL instead of MIT or Apache?

We chose AGPL to ensure Lem remains truly open source. The key difference from MIT/Apache is the "network use" clause:

- **MIT/Apache**: Someone can fork Lem, add proprietary features, and offer it as a closed-source SaaS
- **AGPL**: Anyone running Lem as a network service must share their source code modifications

This protects the community from proprietary forks while still allowing all the freedoms of open source.

### Is AGPL "real" open source?

**Yes!** AGPL v3 is:
- OSI-approved (official open source license)
- FSF-endorsed (free software license)
- Used by major projects: Grafana, Mattermost, Nextcloud, MongoDB (originally)

### Can I use Lem even if my company has a "no GPL/AGPL" policy?

Most "no GPL/AGPL" policies apply to **distributing** GPL code or **linking** it into your products. Lem is a **standalone tool** accessed via REST API and WebSocket, which generally falls outside these restrictions.

However, we recommend:
1. Check with your legal department (we're not lawyers!)
2. Consider our commercial license option if needed (contact: blake@lem.gg)

---

## Using Lem

### Can I use Lem for personal use?

**Yes, absolutely!** No restrictions or registration required.

You can:
- Run the local server on your laptop
- Connect to it remotely
- Modify it for your own needs
- Self-host all components

### Can I use Lem at my company/startup?

**Yes!** AGPL allows commercial use.

You can:
- Use Lem internally for your team
- Run it on company infrastructure
- Integrate it with internal tools
- Access it remotely while traveling

**You do NOT need to open source** your company's code just because you use Lem.

### Can I use Lem on a server and access it over the internet?

**Yes!** This is exactly what Lem is designed for.

Running Lem's cloud services (signaling/relay) for your own use does **not** trigger any open source requirements.

### Do I need to share my configuration or data?

**No.** AGPL only covers the **software code**, not your:
- Configuration files
- Database contents
- AI models
- Personal data
- API keys or credentials

---

## Modifying Lem

### Can I modify Lem's code?

**Yes!** You're free to modify Lem however you like.

### Do I have to share my modifications?

**It depends:**

| Scenario | Must share code? |
|----------|-----------------|
| Modified for personal use | ❌ No |
| Modified for internal company use | ❌ No |
| Modified and run as public network service | ✅ Yes |
| Modified and distributed to others | ✅ Yes |

The key question: **Are you offering it as a service to other people over a network?**

### What counts as "offering as a network service"?

**Examples that require sharing code:**
- ✅ Running a public "Lem-as-a-Service" for customers
- ✅ Offering Lem access to clients/partners
- ✅ Running a multi-tenant Lem instance

**Examples that do NOT require sharing:**
- ❌ Using Lem yourself (even remotely)
- ❌ Your team using Lem internally
- ❌ Your company's IT department hosting Lem for employees

**Gray area (consult a lawyer):**
- Offering Lem to contractors/consultants
- Running Lem for subsidiaries or affiliated companies

### How do I share modifications if required?

If you're running a modified version as a public network service, you must:

1. Make your source code available to your users
2. Include a notice explaining how to get the source
3. License your modifications under AGPL-3.0-or-later
4. Preserve existing copyright notices

**Recommended approach:**
- Host your fork publicly on GitHub
- Add a link in your service's UI: "Source Code"
- Include a README explaining your modifications

---

## Distributing Lem

### Can I redistribute Lem?

**Yes!** You can distribute Lem to others.

### What are my obligations when distributing?

You must:

1. Include the full AGPL v3 license text
2. Preserve all copyright notices
3. Provide source code (or written offer to provide it)
4. Document any changes you made
5. License the whole work under AGPL-3.0-or-later

### Can I bundle Lem with my proprietary product?

**It's complicated.** This depends on how you integrate it:

**✅ Allowed (probably):**
- Distributing Lem alongside your product (separate install)
- Your product calls Lem's API (network boundary)
- Recommending Lem to your users

**❌ Not allowed (without commercial license):**
- Embedding Lem's code into your proprietary app
- Linking Lem libraries into your closed-source software
- Distributing a modified Lem without sharing code

**For embedded/OEM use, contact us about commercial licensing:** blake@lem.gg

### Can I sell Lem?

**Yes!** AGPL allows commercial distribution.

You can:
- Charge for installation/setup services
- Sell support contracts
- Offer managed hosting
- Bundle it with hardware

But you **must** still provide the source code to your customers.

---

## Commercial Use

### Can my business use Lem?

**Yes!** See [Can I use Lem at my company?](#can-i-use-lem-at-my-companystartu p) above.

### Can I offer Lem as a hosted service (SaaS)?

**Yes**, but with AGPL requirements:

If you offer Lem's cloud services (signaling/relay) to third parties:
1. You must provide your source code to your users
2. Any modifications must be open sourced under AGPL
3. You cannot add proprietary features to the relay/signaling servers

**This is the "network use" clause that makes AGPL different from GPL.**

### Can I offer consulting/support for Lem?

**Absolutely!** This is encouraged and perfectly legal.

AGPL does not restrict:
- Charging for services
- Offering support contracts
- Consulting and integration work
- Training and documentation

### I want to build a proprietary product using Lem. What are my options?

Contact us for a **commercial license**: blake@lem.gg

We can offer:
- Proprietary license exceptions
- OEM/embedded licensing
- White-label agreements
- Custom support contracts

---

## Contributing

### If I contribute code, who owns it?

**You do.** You retain copyright to your contributions.

However, by signing off on your commits (DCO), you certify that:
- You have the right to submit the code
- Your contribution will be licensed under AGPL-3.0-or-later
- You agree to the Developer Certificate of Origin terms

See [CONTRIBUTING.md](./CONTRIBUTING.md) for details.

### Can Lem change the license in the future?

**It's very difficult** without permission from all copyright holders.

Since contributors retain their copyright:
- We would need permission from every contributor to relicense
- Or we'd have to rewrite all contributed code

**This protects the community** from future "rug pulls" or license changes.

### What's the difference between CLA and DCO?

Lem uses **DCO (Developer Certificate of Origin)**, not CLA:

**DCO (what Lem uses):**
- Sign off commits with `git commit -s`
- Lightweight, low friction
- You keep your copyright
- Standard in Linux kernel and many OSS projects

**CLA (what Lem does NOT use):**
- Formal legal agreement
- Often transfers rights to the company
- Allows company to relicense without contributor permission
- More controversial in OSS community

---

## Special Cases

### Can I use Lem in a mobile app?

**Yes**, with considerations:

- Apple App Store: AGPL is allowed (despite old myths)
- Google Play Store: No issues
- You must still provide source code to app users

If you want to distribute a closed-source mobile app that embeds Lem, contact us about commercial licensing.

### Can I use Lem in an academic/research setting?

**Absolutely!** AGPL is perfect for research:

- Free to use and modify
- Audit the code for security/correctness
- Share your improvements with the research community
- No restrictions on publication

### Can I use Lem in government/military applications?

**Generally yes**, but:

- Check your organization's policies on open source software
- AGPL requires sharing modifications if deployed as network service
- For classified/sensitive deployments, you may need commercial licensing

Contact us if you need guidance: blake@lem.gg

### What if I'm located in a country with different IP laws?

AGPL is internationally recognized, but:

- Consult a local lawyer for specific guidance
- The license is written under international copyright conventions
- Most countries recognize open source licenses

---

## Getting Help

### I have a specific licensing question

We're happy to help! Contact us at: blake@lem.gg

### Do you offer commercial licenses?

**Yes!** If AGPL doesn't work for your use case, we can provide:

- Proprietary/dual-licensing
- OEM and embedded licenses
- Custom licensing terms
- Enterprise support agreements

Contact: blake@lem.gg

### Where can I read the full license?

- **Full AGPL v3 text**: [LICENSE](./LICENSE) file in this repository
- **Official version**: https://www.gnu.org/licenses/agpl-3.0.html
- **Plain English summary**: https://choosealicense.com/licenses/agpl-3.0/

---

## Disclaimer

**This FAQ is not legal advice.** It provides general guidance about Lem's licensing, but:

- Consult a lawyer for specific situations
- Your jurisdiction may have specific rules
- This FAQ may not cover all edge cases

For official licensing inquiries, contact: blake@lem.gg

---

## Quick Reference

**Can I...**

| Action | Personal | Company Internal | Public SaaS | Commercial Product |
|--------|----------|-----------------|-------------|-------------------|
| Use Lem | ✅ Yes | ✅ Yes | ✅ Yes | ✅ Yes |
| Modify code | ✅ Yes | ✅ Yes | ✅ Yes | ✅ Yes |
| Keep modifications private | ✅ Yes | ✅ Yes | ❌ No* | ❌ No* |
| Charge for services | ✅ Yes | N/A | ✅ Yes | ✅ Yes |
| Distribute binaries | ✅ Yes | ⚠️ Internal only | ✅ Yes* | ⚠️ Need commercial license |

\* Must provide source code to users

---

**Still have questions?** Open a [GitHub Discussion](https://github.com/lem-gg/lem/discussions) or email blake@lem.gg
