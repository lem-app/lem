# Contributing to Lem

Thank you for your interest in contributing to Lem! We welcome contributions from the community.

## 📜 License

Lem is licensed under the GNU Affero General Public License v3.0 or later (AGPL-3.0-or-later).

By contributing to this project, you agree that your contributions will be licensed under the same AGPL-3.0-or-later license.

## 🔏 Developer Certificate of Origin (DCO)

To ensure that all contributions are properly licensed, we use the Developer Certificate of Origin (DCO). This is a lightweight way for contributors to certify that they have the right to submit their code.

### What is DCO?

By signing off on your commits, you certify that you wrote the code or have the right to submit it under the project's license. The full DCO text is available at https://developercertificate.org/

### How to Sign Off

Add a `Signed-off-by` line to your commit messages:

```
git commit -s -m "Add new feature"
```

This adds a sign-off line that looks like:

```
Signed-off-by: Your Name <your.email@example.com>
```

**Important:** The name and email must match your git configuration and your GitHub account.

### Configure Git

Make sure your git config is set correctly:

```bash
git config --global user.name "Your Name"
git config --global user.email "your.email@example.com"
```

### Amending Past Commits

If you forgot to sign off on previous commits:

```bash
# For the last commit
git commit --amend --signoff

# For multiple commits (rebase and sign off each)
git rebase -i HEAD~3  # Replace 3 with number of commits
# Mark commits as 'edit', then for each:
git commit --amend --signoff
git rebase --continue
```

## 🚀 Getting Started

### Prerequisites

- **Python 3.11+** with [uv](https://github.com/astral-sh/uv) package manager
- **Node.js 18+** with [pnpm](https://pnpm.io/) package manager
- **Docker** and Docker Compose
- **Git** with DCO sign-off configured

### Development Setup

1. **Fork and clone the repository**

```bash
git clone https://github.com/YOUR-USERNAME/lem.git
cd lem/lem-app
```

2. **Set up Python environment (local server)**

```bash
cd server
uv sync
uv run pytest  # Run tests
```

3. **Set up TypeScript environment (web apps)**

```bash
cd web/local
pnpm install
pnpm run dev

cd ../remote
pnpm install
pnpm run dev
```

4. **Set up cloud services (optional)**

```bash
cd cloud/signaling
uv sync

cd ../relay
uv sync
```

## 📝 Code Standards

Please read and follow our coding standards in [CLAUDE.md](./CLAUDE.md):

- **Python**: Use `uv` (not pip), strict type hints with mypy, format with ruff
- **TypeScript**: Use `pnpm` (not npm), strict mode enabled, format with prettier
- **UI**: Tailwind CSS + shadcn/ui components (no vanilla CSS)

### Before Submitting

Run these checks locally:

```bash
# Python (server/)
uv run ruff format server/
uv run ruff check server/
uv run mypy server/
uv run pytest

# TypeScript (web/)
cd web/local
pnpm run format
pnpm run lint
pnpm tsc --noEmit
pnpm run test  # if tests exist

cd ../remote
pnpm run format
pnpm run lint
pnpm run type-check
pnpm run test
```

## 🔄 Contribution Workflow

1. **Create a feature branch**

```bash
git checkout -b feature/your-feature-name
```

2. **Make your changes**

- Write clear, concise commit messages
- Include tests for new functionality
- Update documentation as needed
- Add SPDX license headers to new files (see existing files for format)

3. **Sign off your commits**

```bash
git commit -s -m "feat: add new feature"
```

4. **Push and create a pull request**

```bash
git push origin feature/your-feature-name
```

Then open a PR on GitHub with:
- Clear description of the changes
- Reference to any related issues
- Screenshots/demos if applicable

5. **PR Review Process**

- CI checks must pass (linting, type checking, tests)
- All commits must be signed off (DCO)
- At least one maintainer approval required
- Address review feedback

## 🐛 Reporting Bugs

Use GitHub Issues to report bugs. Include:

- Lem version
- Operating system (macOS, Linux, Windows/WSL2)
- Steps to reproduce
- Expected vs actual behavior
- Relevant logs

## 💡 Feature Requests

We welcome feature requests! Please:

- Check existing issues first to avoid duplicates
- Describe the use case and motivation
- Propose a solution if you have one in mind
- Be open to discussion and alternative approaches

## 🛡️ Security Issues

**Do not open public issues for security vulnerabilities.**

Please email blake@lem.gg with:
- Description of the vulnerability
- Steps to reproduce
- Potential impact
- Suggested fix (if any)

We'll respond within 48 hours and work with you on a coordinated disclosure.

## 📚 Documentation

Documentation improvements are always welcome! This includes:

- Code comments and docstrings
- README updates
- Architecture documentation (docs/)
- API documentation
- Tutorials and guides

## 🎯 Good First Issues

Look for issues labeled `good-first-issue` on GitHub. These are beginner-friendly tasks that are well-scoped and don't require deep knowledge of the codebase.

## 🤝 Code of Conduct

We are committed to providing a welcoming and inclusive environment. Please:

- Be respectful and considerate
- Assume good intent
- Accept constructive criticism gracefully
- Focus on what's best for the community
- Show empathy towards others

Unacceptable behavior includes harassment, trolling, personal attacks, or discriminatory language.

## 📞 Questions?

- GitHub Discussions: For general questions and discussions
- GitHub Issues: For bug reports and feature requests
- Discord: [Coming soon]

## 🙏 Thank You!

Your contributions make Lem better for everyone. We appreciate your time and effort!
