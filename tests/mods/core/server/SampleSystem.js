import { System } from "../../../core/systems/System.js"


export default class SampleSystem extends System {
  static name = 'sample'

  constructor(world) {
    super(world)
    
    console.log('SampleSystem constructor')
    console.log(this.name)
  }

  init(options) {
    console.log('SampleSystem init')

    this.world.network.onMyPacket = this.onMyPacket.bind(this)
  }

  onMyPacket(socket, data) {
    console.log('myPacket', data)
    // socket.send('myPacket', { message: 'Hello from server' })
    this.world.network.sendTo(socket.id, 'myPacket', { message: 'Hello from server' })
  }

}
