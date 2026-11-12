import { Controller, Get, Module } from '@nestjs/common'
import { NestFactory } from '@nestjs/core'
import { NodeAdapter } from '@nestjs/platform-node'

@Controller()
class AppController {
  @Get()
  hello(): string {
    return 'Hello Nest!'
  }

  @Get('json')
  json(): { hello: string } {
    return { hello: 'world' }
  }
}

@Module({ controllers: [AppController] })
class AppModule {}

const app = await NestFactory.create(AppModule, new NodeAdapter(), { logger: false })
await app.listen(3900)
console.log('nest-native listening on http://127.0.0.1:3900')
