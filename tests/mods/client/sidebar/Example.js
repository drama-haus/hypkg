import { css } from '@firebolt-dev/css'
import { InfoIcon } from 'lucide-react'
import { useState } from 'react'
import { Section, Btn, Pane, Group } from '../../../client/components/Sidebar'

// This component will be used as the button in the sidebar
export function ExampleButton() {
  return <InfoIcon size='1.25rem' />
}

// This component will be rendered as a pane when the button is clicked
export function ExamplePane({ world, hidden }) {
  const [count, setCount] = useState(0)
  
  return (
    <Pane hidden={hidden}>
      <div
        className='example-pane'
        css={css`
          background: rgba(11, 10, 21, 0.85);
          border: 0.0625rem solid #2a2b39;
          backdrop-filter: blur(5px);
          border-radius: 1rem;
          display: flex;
          flex-direction: column;
          min-height: 17rem;
          
          .example-head {
            height: 3.125rem;
            padding: 0 1rem;
            border-bottom: 1px solid rgba(255, 255, 255, 0.05);
            display: flex;
            align-items: center;
          }
          
          .example-title {
            font-weight: 500;
            font-size: 1rem;
            line-height: 1;
          }
          
          .example-content {
            flex: 1;
            overflow-y: auto;
            padding: 1rem;
          }
          
          .example-button {
            background: rgba(255, 255, 255, 0.1);
            border-radius: 0.5rem;
            padding: 0.5rem 1rem;
            margin-top: 1rem;
            cursor: pointer;
            display: inline-block;
            
            &:hover {
              background: rgba(255, 255, 255, 0.2);
            }
          }
        `}
      >
        <div className='example-head'>
          <div className='example-title'>Example Mod</div>
        </div>
        <div className='example-content noscrollbar'>
          <div>This is an example sidebar pane from a mod.</div>
          <Group label="Interaction" />
          <div>Count: {count}</div>
          <div 
            className='example-button'
            onClick={() => setCount(count + 1)}
          >
            Increment
          </div>
        </div>
      </div>
    </Pane>
  )
} 