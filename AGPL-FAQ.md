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

We chose AGPL to keep improvements to Lem in the open. The difference from MIT/Apache is the "network use" clause (§13):

- **MIT/Apache**: Someone can fork Lem, add proprietary features, and offer it as a closed-source SaaS
- **AGPL**: Someone who **modifies** Lem and offers the modified version over a network must give those users the source of their version

Note the condition. §13 is triggered by modification. Running Lem unmodified as a network service — including as a paid service — triggers nothing. AGPL forecloses proprietary forks; it does not foreclose competition. See [Can someone sell Lem as a service without contributing anything back?](#can-someone-sell-lem-as-a-service-without-contributing-anything-back)

### Is AGPL "real" open source?

**Yes!** AGPL v3 is:
- OSI-approved (official open source license)
- FSF-endorsed (free software license)
- Used by major projects: Grafana, Mattermost, Nextcloud, MongoDB (originally)

### Can I use Lem even if my company has a "no GPL/AGPL" policy?

Depends on the policy. Many "no GPL/AGPL" policies target **distributing** GPL code or **linking** it into your products, and Lem is a **standalone tool** accessed via REST API and WebSocket, so it often falls outside them. Some policies, though, ban AGPL software outright regardless of how it is used. Read your own policy rather than assuming.

We recommend:
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
| Unmodified, however you run it | ❌ No |
| Modified for personal use | ❌ No |
| Modified for internal company use | ❌ No |
| Modified and run as public network service | ✅ Yes |
| Modified and distributed to others | ✅ Yes |

Two questions, and both have to be yes: **have you modified Lem?** and **are you putting it in front of other people**, over a network or as a copy? If you have not modified Lem, §13 never fires, no matter who you serve.

### What counts as "offering as a network service"?

Everything in this section assumes you have **modified** Lem. If you have not, none of it applies.

**Examples that require sharing code:**
- ✅ Running a public "Lem-as-a-Service" for customers on your modified build
- ✅ Giving clients/partners access to your modified build
- ✅ Running a modified multi-tenant Lem instance

**Examples that do NOT require sharing:**
- ❌ Running Lem unmodified, for anyone, at any scale
- ❌ Using your modified Lem yourself (even remotely)
- ❌ Your team using your modified Lem internally
- ❌ Your company's IT department hosting your modified Lem for employees

**Gray area (consult a lawyer):**
- Offering your modified Lem to contractors/consultants
- Running your modified Lem for subsidiaries or affiliated companies

### How do I share modifications if required?

If you're running a modified version and users interact with it over a network, you must:

1. Offer those users the Corresponding Source of your version, from a network server, at no charge
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

**Yes.** If you run Lem's cloud services (signaling/relay) **unmodified**, you owe nothing beyond keeping the copyright and license notices intact. You may charge for it.

If you **modify** them and offer the modified version over a network, §13 applies:
1. You must offer your users an opportunity to receive the Corresponding Source of your version, from a network server, at no charge
2. Your modifications are licensed under AGPL-3.0-or-later
3. You cannot keep proprietary features in the relay/signaling servers to yourself — adding them is a modification

**This is the "network use" clause that makes AGPL different from GPL.** It is triggered by modification, not by hosting.

### Can someone sell Lem as a service without contributing anything back?

**Yes, if they don't modify it.** A competitor can stand up Lem exactly as published — local server, signaling, relay — sell access to it, and owe the project nothing. AGPL-3.0 does not prevent that.

What AGPL prevents is the proprietary fork. The moment they change Lem to make their offering better and put that in front of users over a network, §13 obliges them to publish the changed source. They can compete with us on our own code; they cannot build a closed, differentiated product on top of it and keep the differentiation to themselves. Improvements come back.

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
- If you modify Lem and deploy it as a network service, AGPL requires you to share those modifications with its users
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
| Run Lem **unmodified** and share nothing back | ✅ Yes | ✅ Yes | ✅ Yes | ❌ No† |
| Modify code | ✅ Yes | ✅ Yes | ✅ Yes | ✅ Yes |
| Keep **your modifications** private | ✅ Yes | ✅ Yes | ❌ No* | ❌ No* |
| Charge for services | ✅ Yes | N/A | ✅ Yes | ✅ Yes |
| Distribute binaries | ✅ Yes† | ⚠️ Internal only | N/A | ⚠️ Need commercial license |

\* Applies only if you modified Lem. You must offer your version's source to the people using your instance — not to the world. If you have not modified Lem, nothing is owed; see the "Run Lem unmodified" row.

† Distributing a copy — modified or not — carries the source-availability obligations in §4–§6. Those are separate from §13 and are not conditioned on modification, which is why an unmodified Lem inside a product you ship is not "share nothing back", while an unmodified Lem you host is.

---

**Still have questions?** Open a [GitHub Discussion](https://github.com/lem-gg/lem/discussions) or email blake@lem.gg
