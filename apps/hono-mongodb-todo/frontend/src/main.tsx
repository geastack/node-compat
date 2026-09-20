import App from './app'
import './styles.css'

const root = document.getElementById('app')

if (root === null) {
  throw new Error('Missing #app mount element')
}

new App().render(root)
