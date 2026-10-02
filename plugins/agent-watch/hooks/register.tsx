import type { Register } from 'claude-code'

import { readOptions } from './shared'

export const register: Register = (on, options) => {
  const config = readOptions(options)
  void config
  void on
}
