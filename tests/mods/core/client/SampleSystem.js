import { System } from '../../../core/systems/System.js'

export default class SampleSystem extends System {
  static name = 'sample'
  constructor(world) {
    super(world)

    console.log('SampleSystem constructor')
    console.log(this.name)
  }

  init(options) {
    console.log('SampleSystem init')

    // this.world.network.onMyPacket = this.onMyPacket.bind(this)
    // this.world.network.send('myPacket', { message: 'Hello from client' })
    setTimeout(() => {
      this.world.network.send('myPacket', { message: 'Hello from client' })
    }, 2000)

    this.world.network.onMyPacket = this.onMyPacket.bind(this)
  }

  onMyPacket(data) {
    console.log('myPacket', data)
  }
}
