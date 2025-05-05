import { useState, useEffect } from 'react'

export default function ExampleComponent({ world }) {
  const [count, setCount] = useState(0)

  useEffect(() => {
    world.events.on('player', player => {
      setCount(player.data.name.length)
    })
  }, [])

  console.log('ExampleComponent rendered', world)

  return (
    <div>
      <h1>Example Component</h1>
      <p>Count: {count}</p>
    </div>
  )
}
