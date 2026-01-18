# Research Chat Trees

React frontend for a branching chat experience. Highlight text in the chat to
spawn a new branch and keep a structured tree of research conversations.

## Setup

1. Install dependencies:
   `npm install`
2. Create a `.env` file in the project root:
   `VITE_OPENAI_API_KEY=sk-your-key-here`
3. Start the dev server:
   `npm run dev`

## Usage

- Ask questions in the main chat panel.
- Highlight any text in the chat to open the branch popover.
- Submit a new prompt to create a child node in the tree.
