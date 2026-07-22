// Why: OMP 15.x discovers built-in user extensions from ~/.omp/agent, but a
// typed `omp` in an existing terminal still needs Botmux's status extension
// passed explicitly. Do not redirect PI_CODING_AGENT_DIR here: that variable
// is OMP's mutable home, so config/auth/session commands must keep the user's
// normal source of truth.

const OMP_SUBCOMMANDS = [
  '__complete',
  'acp',
  'agents',
  'auth-broker',
  'auth-gateway',
  'bench',
  'commit',
  'completions',
  'config',
  'dry-balance',
  'gallery',
  'grep',
  'grievances',
  'install',
  'join',
  'models',
  'plugin',
  'read',
  'say',
  'search',
  'setup',
  'shell',
  'ssh',
  'stats',
  'tiny-models',
  'token',
  'ttsr',
  'update',
  'usage',
  'worktree',
  'q',
  'wt'
] as const

export function getPosixOmpShellWrapper(): string {
  const subcommands = OMP_SUBCOMMANDS.join('|')
  return `# Why: OMP does not auto-load Botmux's managed status extension; wrap only
# interactive launch invocations so subcommands such as \`omp config\` keep
# their normal argv shape.
__botmux_omp_should_skip_extension() {
  case "\${1:-}" in
    help|--help|-h|--version|-v) return 0 ;;
    ${subcommands}) return 0 ;;
  esac
  return 1
}
__botmux_omp() {
  local __botmux_use_extension=1
  __botmux_omp_should_skip_extension "\${1:-}" && __botmux_use_extension=0
  if [[ $__botmux_use_extension -eq 1 && -n "\${BOTMUX_OMP_STATUS_EXTENSION:-}" && -f "\${BOTMUX_OMP_STATUS_EXTENSION}" ]]; then
    if [[ "\${1:-}" == "launch" ]]; then
      shift
      command omp launch --extension "\${BOTMUX_OMP_STATUS_EXTENSION}" "$@"
    else
      command omp --extension "\${BOTMUX_OMP_STATUS_EXTENSION}" "$@"
    fi
  else
    command omp "$@"
  fi
}
if [[ -n "\${BOTMUX_OMP_STATUS_EXTENSION:-}" ]]; then
  omp() { __botmux_omp "$@"; }
fi
`
}

export function getPowerShellOmpShellWrapper(): string {
  const subcommands = OMP_SUBCOMMANDS.map((value) => `'${value}'`).join(', ')
  return `# Why: OMP does not auto-load Botmux's managed status extension; wrap only
# interactive launch invocations so subcommands such as \`omp config\` keep
# their normal argv shape.
function Global:__BotmuxOmpShouldSkipExtension {
    param([string]$Name)
    $skip = @("help", "--help", "-h", "--version", "-v") + @(${subcommands})
    return $skip -contains $Name
}
if ($env:BOTMUX_OMP_STATUS_EXTENSION) {
    function Global:omp {
        $botmuxUseExtension = -not (__BotmuxOmpShouldSkipExtension -Name ([string]($args[0])))
        $botmuxStatus = 0
        $botmuxCommand = Get-Command omp -CommandType Application,ExternalScript -ErrorAction SilentlyContinue | Select-Object -First 1
        if (-not $botmuxCommand) {
            Write-Error "omp executable not found"
            $botmuxStatus = 127
        } elseif ($botmuxUseExtension -and $env:BOTMUX_OMP_STATUS_EXTENSION -and
            (Test-Path -LiteralPath $env:BOTMUX_OMP_STATUS_EXTENSION)) {
            if ($args.Count -gt 0 -and $args[0] -eq "launch") {
                $botmuxLaunchArgs = @($args | Select-Object -Skip 1)
                & $botmuxCommand.Source launch --extension $env:BOTMUX_OMP_STATUS_EXTENSION @botmuxLaunchArgs
            } else {
                & $botmuxCommand.Source --extension $env:BOTMUX_OMP_STATUS_EXTENSION @args
            }
            $botmuxStatus = $LASTEXITCODE
        } else {
            & $botmuxCommand.Source @args
            $botmuxStatus = $LASTEXITCODE
        }

        $global:LASTEXITCODE = $botmuxStatus
    }
}
`
}
