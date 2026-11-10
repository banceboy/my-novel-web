/**
 * 账号管理命令行（不暴露任何 HTTP 注册接口）。
 *
 *   node server/auth-cli.mjs list
 *   node server/auth-cli.mjs add <username> <password> [--admin]
 *   node server/auth-cli.mjs passwd <username> <newPassword>
 *   node server/auth-cli.mjs disable <username> | enable <username>
 *   node server/auth-cli.mjs quota <username> dailyAiCalls=500
 *
 * DATA_ROOT 必须与网关一致（默认 ./data）。口令不要写进 shell 历史，
 * 生产环境建议用环境变量 XST_CLI_PASSWORD 传入。
 */
import {
  createUser, listUsers, loadAuthStore, setDisabled, setPassword, setQuota,
} from './auth.mjs'

const [command, ...args] = process.argv.slice(2)
const secret = (value) => value === '__env__' ? process.env.XST_CLI_PASSWORD : value

try {
  loadAuthStore()
  switch (command) {
    case 'list':
      console.log(JSON.stringify(listUsers(), null, 2))
      break
    case 'add': {
      const [username, raw, flag] = args
      const user = createUser(username, secret(raw), flag === '--admin' ? 'admin' : 'user')
      console.log(`created: ${user.username} (${user.role}) id=${user.id}`)
      break
    }
    case 'passwd':
      setPassword(args[0], secret(args[1]))
      console.log('password updated; all sessions for this user were revoked')
      break
    case 'disable':
    case 'enable':
      setDisabled(args[0], command === 'disable')
      console.log(`${args[0]} ${command === 'disable' ? 'disabled' : 'enabled'}`)
      break
    case 'quota': {
      const patch = Object.fromEntries(args.slice(1).map(entry => {
        const [key, value] = entry.split('=')
        return [key, Number(value)]
      }))
      const user = setQuota(args[0], patch)
      console.log(JSON.stringify(user.quota, null, 2))
      break
    }
    default:
      console.log('用法: auth-cli.mjs list | add <user> <password> [--admin] | passwd <user> <password> | disable|enable <user> | quota <user> key=value')
      process.exitCode = command ? 1 : 0
  }
} catch (error) {
  console.error(`[auth-cli] ${error?.message ?? error}`)
  process.exitCode = 1
}
