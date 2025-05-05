# Sidebar Mods

This directory contains sidebar mod components that will be automatically imported and rendered in the Hyperfy sidebar.

## How to Create a Sidebar Mod

Each sidebar mod should be a single JavaScript file that exports two components:

1. `[Name]Button` - The button component shown in the sidebar
2. `[Name]Pane` - The pane component shown when the button is clicked

For example, in a file called `MyMod.js`:

```jsx
import { InfoIcon } from 'lucide-react'
import { Pane } from '../../../client/components/Sidebar'

// The button component - name must end with 'Button'
export function MyModButton() {
  return <InfoIcon size='1.25rem' />
}

// The pane component - name must end with 'Pane'
export function MyModPane({ world, hidden }) {
  return (
    <Pane hidden={hidden}>
      <div>
        <h1>My Mod Pane</h1>
        <p>This is my custom sidebar pane!</p>
      </div>
    </Pane>
  )
}
```

## Available Components

The following components from the Sidebar can be imported and used in your mod:

```jsx
import { Section, Btn, Content, Pane, Hint, Group } from '../../../client/components/Sidebar'
```

- `Section` - A container for buttons
- `Btn` - A sidebar button
- `Content` - A basic content container
- `Pane` - A sidebar pane
- `Hint` - A hint box
- `Group` - A group divider with optional label

## Styling

To match the Hyperfy UI style, use the following CSS for your pane:

```css
background: rgba(11, 10, 21, 0.85);
border: 0.0625rem solid #2a2b39;
backdrop-filter: blur(5px);
border-radius: 1rem;
```

See the `Example.js` file for a complete example. 