/**
 * Example shared system that runs on both client and server
 * Demonstrates environment-specific code branches
 */
import { System } from '../../../core/systems/System.js'

export default class ExampleShared extends System {
  static name = 'exampleshared'

  constructor(world) {
    super(world)

    console.log('ExampleShared constructor')
  }

  init() {
    console.log('ExampleShared initialized on Client')

    // Packets are now defined in mods/core/packets/*.js
    // No need to call addPacket here anymore
    
    const self = this
    this.world.inject({
      // Add custom player properties and methods
      player: {
        // Custom method
        greet(entity, player, message = 'Hello') {
          const name = player.data.name || 'Player'
          console.log(`${message}, ${name}!`)
          return `${message}, ${name}!`
        },
        test(entity, player) {
          console.log('test', self)
          self.test(player)
        }
      }
    })
  }

  test(player) {
    console.log('test', ExampleShared.name, player)
  }
}
