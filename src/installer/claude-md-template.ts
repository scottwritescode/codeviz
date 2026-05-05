/**
 * CLAUDE.md template for CodeViz instructions
 *
 * This template is injected into ~/.claude/CLAUDE.md (global) or ./.claude/CLAUDE.md (local)
 * Keep this in sync with the README.md "Recommended: Add Global Instructions" section
 */

// Markers to identify CodeViz section for updates
export const CODEVIZ_SECTION_START = '<!-- CODEVIZ_START -->';
export const CODEVIZ_SECTION_END = '<!-- CODEVIZ_END -->';

export const CLAUDE_MD_TEMPLATE = `${CODEVIZ_SECTION_START}
## CodeViz

CodeViz builds a semantic knowledge graph of codebases for faster, smarter code exploration.

### If \`.codeviz/\` exists in the project

**NEVER call \`codeviz_explore\` or \`codeviz_context\` directly in the main session.** These tools return large amounts of source code that fills up main session context. Instead, ALWAYS spawn an Explore agent for any exploration question (e.g., "how does X work?", "explain the Y system", "where is Z implemented?").

**When spawning Explore agents**, include this instruction in the prompt:

> This project has CodeViz initialized (.codeviz/ exists). Use \`codeviz_explore\` as your PRIMARY tool — it returns full source code sections from all relevant files in one call.
>
> **Rules:**
> 1. Follow the explore call budget in the \`codeviz_explore\` tool description — it scales automatically based on project size.
> 2. Do NOT re-read files that codeviz_explore already returned source code for. The source sections are complete and authoritative.
> 3. Only fall back to grep/glob/read for files listed under "Additional relevant files" if you need more detail, or if codeviz returned no results.

**The main session may only use these lightweight tools directly** (for targeted lookups before making edits, not for exploration):

| Tool | Use For |
|------|---------|
| \`codeviz_search\` | Find symbols by name |
| \`codeviz_callers\` / \`codeviz_callees\` | Trace call flow |
| \`codeviz_impact\` | Check what's affected before editing |
| \`codeviz_node\` | Get a single symbol's details |

### If \`.codeviz/\` does NOT exist

At the start of a session, ask the user if they'd like to initialize CodeViz:

"I notice this project doesn't have CodeViz initialized. Would you like me to run \`codeviz init -i\` to build a code knowledge graph?"
${CODEVIZ_SECTION_END}`;
