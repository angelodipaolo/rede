
**Goal: a local code review command center**

I want a tool that runs entirely on my Mac and turns reviewing a git diff into a conversation with a coding agent. I should be able to read a diff the way I would on a GitHub pull request, ask questions or leave comments on specific lines, and have a coding agent (Claude Code, Codex, or anything else that speaks MCP/CLI/Skill) respond in those threads while I keep reviewing. No GitHub, no pushing, no cloud. My repo, my machine, my agent.

**What it should do**

- **Review any local diff:** uncommitted changes, a branch compared to its base, a commit or a range. Starting a review should take a single command from inside a repo.
- **Feel like a GitHub PR review, or better.** A file tree with only the changed files. Clicking a file jumps to it. Files can be collapsed and expanded and marked as viewed, which hides them and tracks my progress. Reading the diff should be comfortable, with syntax highlighting and a choice of split or unified view.
- **Comment threads on lines and ranges.** I can ask questions, raise concerns or leave notes, and the agent replies in the same thread. A thread goes back and forth until I resolve it.
- **Agents are first-class reviewers.** A coding agent connects to an open review over MCP or CLI. It can wait for new comments, see each one with enough code context to answer well, investigate the codebase on its own, and reply. While waiting, it should do no work and use no tokens. Its replies should show up live, without a refresh, and it should be obvious which messages came from me and which from the agent. Agents can also start threads themselves, so I can ask one to review the diff and leave its findings as comments. You decide if we should use CLI or MCP.
- **Reviews persist.** Comments, replies and viewed state survive restarts and stay tied to the code they're about. If I close everything and reopen tomorrow, I pick up where I left off, and so does the agent.

**Constraints**

- Everything stays local and nothing leaves my machine, except what the agent itself sends to its model.
- It must work with more than one agent. Don't build it around a single vendor. But I only use codex and claude so don't obsess over harness support. 
- Keep it light: fast to start, and no heavy dependencies or background services to manage.

**What success looks like**

I'm reviewing a meaningful branch. I leave a question on a confusing line, keep reading, and a minute later a well-researched answer is waiting in the thread. I ask a follow-up, mark files as viewed as I go, and at the end I have a reviewed diff and a record of the conversation. The tool fades into the background and the review feels faster and deeper than doing it alone.

**Ownership**

You own the product and technical decisions: architecture, stack, UI design, how agents connect, how review data is stored, and anything I haven't thought of. Make choices that best serve the experience above, and tell me about the major ones and why you made them. If a requirement seems wrong or holds the product back, challenge it.

Commit frequently and verify your changes. Use opus sub agents to do the work while you own the coordination and review.
