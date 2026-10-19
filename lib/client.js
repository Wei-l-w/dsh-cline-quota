/**
 * dsh-cline-quota — browser half.
 *
 * Hand-written client bundle in the DSH module-loader format: executing this
 * file only registers a factory; the factory materializes the plugin body
 * (`{ apply, inject }`) when the loader imports the plugin.
 *
 * The plugin contributes one entry to the session header's **right-aligned
 * utilities seat** (`conversation.session.header.utilities`), so the quota
 * indicator sits in the header row beside the agent-preset and background-job
 * chips. That seat is the additive one the product reserves for exactly this:
 * "right-aligned Session utilities kept outside the title-adjacent action
 * group, so an optional utility cannot reorder session context or lineage".
 *
 * The chip shows the 5-hour window (the tightest one) at a glance; clicking it
 * opens a fixed-positioned popover with all three rolling windows, their reset
 * countdowns, the plan, and the credit balance.
 *
 * API surface verified against DSH 0.2.1-rc.2 shipped sources
 * (`ui-conversation`'s header slot declarations and render site,
 * `ui-jobs`/`ui-agent-preset` as the resident entries of the same row).
 *
 * No build step: plain JS plus the module-loader wrapper, so it can be edited
 * and reloaded directly.
 */
window.__ModuleLoader__.load({
  id: 'dsh-cline-quota',
  factory: function (require) {
    'use strict'

    var React = require('react')
    var h = React.createElement
    var useState = React.useState
    var useEffect = React.useEffect
    var useRef = React.useRef

    /** Host route registered by this package's host half. */
    var ENDPOINT = '/api/cline-quota'
    /**
     * Diagnostics route of the same host half. The panel reports that its
     * bundle executed and that the chip mounted, which is what makes the
     * plugin's presence in a running GUI verifiable without seeing the screen.
     */
    var DIAG_ENDPOINT = '/api/cline-quota/diag'
    /** Routes that store a pasted key and forget a stored account. */
    var KEY_ENDPOINT = '/api/cline-quota/key'
    var KEY_REMOVE_ENDPOINT = '/api/cline-quota/key/remove'
    /** Background refresh cadence. */
    var POLL_MS = 60000
    /** Header utilities entry identity. */
    var CHIP_ID = 'cline-quota'
    var CHIP_TITLE = 'Cline 额度'

    var GREEN = '#30a46c'
    var AMBER = '#f5a524'
    var RED = '#e5484d'

    var MUTED = 'color-mix(in srgb, currentColor 55%, transparent)'
    var HAIRLINE = '1px solid color-mix(in srgb, currentColor 16%, transparent)'
    var TRACK = 'color-mix(in srgb, currentColor 12%, transparent)'
    var CHIP_BG = 'color-mix(in srgb, currentColor 7%, transparent)'

    /** Card surfaces, icon tiles and accent tints used by the panel's design. */
    var RADIUS = 10
    var CARD_BG = 'color-mix(in srgb, currentColor 3.5%, transparent)'
    var CARD_BORDER = '1px solid color-mix(in srgb, currentColor 9%, transparent)'
    var TILE_BG = 'color-mix(in srgb, ' + GREEN + ' 15%, transparent)'
    var SUMMARY_BG = 'color-mix(in srgb, ' + GREEN + ' 9%, transparent)'

    /** Inline line icons: the panel ships no icon dependency. */
    var ICONS = {
      cube: 'M12 3 20 7.5v9L12 21 4 16.5v-9L12 3 M12 12l8-4.5 M12 12v9 M12 12 4 7.5',
      clock: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18 M12 7.5v5l3.2 1.9',
      calendar:
        'M4.5 6.5A1.5 1.5 0 0 1 6 5h12a1.5 1.5 0 0 1 1.5 1.5v12A1.5 1.5 0 0 1 18 20H6a1.5 1.5 0 0 1-1.5-1.5v-12z M4.5 10h15 M8.5 3.2v3.6 M15.5 3.2v3.6',
      bars: 'M5.5 20V12 M12 20V5 M18.5 20v-5.5',
      database:
        'M4.5 7c0-1.7 3.4-3 7.5-3s7.5 1.3 7.5 3-3.4 3-7.5 3-7.5-1.3-7.5-3z M4.5 7v10c0 1.7 3.4 3 7.5 3s7.5-1.3 7.5-3V7 M4.5 12c0 1.7 3.4 3 7.5 3s7.5-1.3 7.5-3',
      pulse: 'M3 12h3.6l2.4-6 4 12 2.4-6H21',
      refresh: 'M20.5 12a8.5 8.5 0 1 1-2.5-6 M20.5 4.5V10h-5.5',
      info: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18 M12 11v5.5 M12 7.8h.01',
      card: 'M3.5 7.5A1.5 1.5 0 0 1 5 6h14a1.5 1.5 0 0 1 1.5 1.5v9A1.5 1.5 0 0 1 19 18H5a1.5 1.5 0 0 1-1.5-1.5v-9z M3.5 10.5h17',
      gauge: 'M3.3 19a10 10 0 1 1 17.4 0 M12 14.2l4.2-4.2',
      user: 'M12 12.5a4 4 0 1 0 0-8 4 4 0 0 0 0 8z M4.6 20.5a7.4 7.4 0 0 1 14.8 0',
      switch: 'M8 3.2 4.2 7 8 10.8 M4.2 7h15.6 M16 20.8 19.8 17 16 13.2 M19.8 17H4.2',
      plus: 'M12 5v14 M5 12h14',
      x: 'M6 6l12 12 M18 6 6 18',
    }

    /** Which tile icon each quota window uses. */
    var LIMIT_ICONS = { five_hour: 'clock', weekly: 'calendar', monthly: 'bars' }

    /** One inline line icon, drawn in `currentColor` unless a colour is given. */
    function icon(name, size, color) {
      return h(
        'svg',
        {
          viewBox: '0 0 24 24',
          width: size || 16,
          height: size || 16,
          fill: 'none',
          stroke: color || 'currentColor',
          strokeWidth: 1.7,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          'aria-hidden': 'true',
          focusable: 'false',
          style: { flex: 'none', display: 'block' },
        },
        h('path', { d: ICONS[name] || ICONS.cube }),
      )
    }

    /** The tinted rounded tile an icon sits in. */
    function tile(name, size) {
      var box = size || 28
      return h(
        'span',
        {
          style: {
            flex: 'none',
            width: box,
            height: box,
            borderRadius: Math.round(box / 3),
            background: TILE_BG,
            color: GREEN,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
          },
        },
        icon(name, Math.round(box * 0.57)),
      )
    }

    /** A small rounded badge; `tone` is 'green' or the neutral default. */
    function pill(text, tone) {
      var green = tone === 'green'
      return h(
        'span',
        {
          style: {
            flex: 'none',
            padding: '1px 7px',
            borderRadius: 999,
            background: green
              ? 'color-mix(in srgb, ' + GREEN + ' 16%, transparent)'
              : 'color-mix(in srgb, currentColor 8%, transparent)',
            color: green ? GREEN : MUTED,
            fontSize: 10,
            fontWeight: green ? 700 : 400,
            lineHeight: '16px',
            whiteSpace: 'nowrap',
          },
        },
        text,
      )
    }

    /** A small square icon button, as used by the account row. */
    function iconButton(name, title, onClick) {
      return h(
        'button',
        {
          type: 'button',
          title: title,
          onClick: onClick,
          style: {
            appearance: 'none',
            flex: 'none',
            width: 26,
            height: 26,
            padding: 0,
            borderRadius: 8,
            border: CARD_BORDER,
            background: 'transparent',
            color: 'inherit',
            cursor: 'pointer',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
          },
        },
        icon(name, 14),
      )
    }

    /** Dot colours for the model list, in the order the models are listed. */
    var DOT_COLORS = [GREEN, '#3e63dd', '#8e4ec6', '#f5a524', '#e5484d', '#0d9488']

    /** A hairline divider between flat rows. */
    var DIVIDER = '1px solid color-mix(in srgb, currentColor 8%, transparent)'

    /** Bar colour by pressure: green, amber past 70%, red past 90%. */
    function barColor(percent) {
      if (typeof percent !== 'number') return 'color-mix(in srgb, currentColor 40%, transparent)'
      if (percent >= 90) return RED
      if (percent >= 70) return AMBER
      return GREEN
    }

    /** Percentage text: one decimal below 10% so small movement is visible. */
    function formatPercent(percent) {
      if (typeof percent !== 'number') return '—'
      if (percent >= 10) return Math.round(percent) + '%'
      return Math.round(percent * 10) / 10 + '%'
    }

    /** Compact token count: 1.2K / 64.9M / 1.10B. */
    function formatTokens(count) {
      if (typeof count !== 'number' || !isFinite(count)) return '—'
      if (count >= 1e9) return (count / 1e9).toFixed(2) + 'B'
      if (count >= 1e6) return (count / 1e6).toFixed(1) + 'M'
      if (count >= 1e3) return (count / 1e3).toFixed(1) + 'K'
      return String(Math.round(count))
    }

    /** Human remaining time until an ISO instant. */
    function formatRemaining(iso, now) {
      if (!iso) return null
      var target = Date.parse(iso)
      if (isNaN(target)) return null
      var ms = target - now
      if (ms <= 0) return '即将重置'
      var minutes = Math.floor(ms / 60000)
      var days = Math.floor(minutes / 1440)
      var hours = Math.floor((minutes % 1440) / 60)
      var mins = minutes % 60
      if (days > 0) return days + ' 天 ' + hours + ' 小时'
      if (hours > 0) return hours + ' 小时 ' + mins + ' 分'
      return mins + ' 分'
    }

    /** Local clock time of an ISO instant. */
    function formatClock(iso) {
      if (!iso) return null
      var date = new Date(iso)
      if (isNaN(date.getTime())) return null
      return date.toLocaleString()
    }

    /**
     * One fetch of the host route, normalized to a result object.
     * @param force - bypass the host's cache.
     * @param range - `{ window: '24h' }`, `{ from, to }` (`YYYY-MM-DD`), or null.
     * @param account - the account label to read, or null for the host's default.
     */
    function requestQuota(force, range, account) {
      var params = []
      if (account) params.push('account=' + encodeURIComponent(account))
      if (range && range.window) {
        params.push('window=' + encodeURIComponent(range.window))
      } else if (range && range.from && range.to) {
        params.push('from=' + encodeURIComponent(range.from), 'to=' + encodeURIComponent(range.to))
      }
      if (force) params.push('refresh=1')
      var url = params.length ? ENDPOINT + '?' + params.join('&') : ENDPOINT
      return fetch(url, {
        headers: { accept: 'application/json' },
        cache: 'no-store',
      })
        .then(function (response) {
          return response.json()
        })
        .catch(function (error) {
          return { ok: false, error: String((error && error.message) || error) }
        })
    }

    /**
     * One JSON POST to a host route, normalized to a result object.
     * @param url - the route to post to.
     * @param body - the JSON body.
     */
    function postJson(url, body) {
      return fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        cache: 'no-store',
      })
        .then(function (response) {
          return response.json()
        })
        .catch(function (error) {
          return { ok: false, error: String((error && error.message) || error) }
        })
    }

    /**
     * Report one lifecycle event to the host's diagnostics route. Best effort:
     * a failed beacon must never affect the panel.
     * @param event - 'applied' (bundle executed) or 'mounted' (chip rendered).
     * @param extra - optional extra fields.
     */
    function beacon(event, extra) {
      try {
        var body = { event: event, tab: CHIP_ID }
        if (extra) {
          for (var key in extra) {
            if (Object.prototype.hasOwnProperty.call(extra, key)) body[key] = extra[key]
          }
        }
        if (typeof navigator !== 'undefined' && navigator && navigator.userAgent) {
          body.userAgent = navigator.userAgent
        }
        if (typeof location !== 'undefined' && location) {
          // Origin + path only: the desktop host's authenticated URL carries its
          // token in the query string, which must not be copied into the log.
          body.page = String(location.origin || '') + String(location.pathname || '')
        }
        fetch(DIAG_ENDPOINT, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
          cache: 'no-store',
        }).catch(function () {})
      } catch (error) {
        /* diagnostics are never load-bearing */
      }
    }

    /**
     * Shared quota reader: polls while mounted and refetches when the token
     * range or the selected account changes.
     * @param range - `{ from, to }` or null for the host's default range.
     * @param account - the selected account label, or null for the host's first.
     */
    function useQuota(range, account) {
      var payloadPair = useState(null)
      var payload = payloadPair[0]
      var setPayload = payloadPair[1]

      var errorPair = useState(null)
      var error = errorPair[0]
      var setError = errorPair[1]

      var busyPair = useState(false)
      var busy = busyPair[0]
      var setBusy = busyPair[1]

      var aliveRef = useRef(true)
      var rangeKey =
        range && range.window
          ? 'window:' + range.window
          : range && range.from && range.to
            ? range.from + '|' + range.to
            : 'default'
      var accountKey = account || ''

      function load(force) {
        setBusy(true)
        return requestQuota(force, range, account).then(function (result) {
          if (!aliveRef.current) return
          setBusy(false)
          if (result && result.ok) {
            setPayload(result)
            setError(null)
          } else {
            setError((result && result.error) || '未知错误')
          }
        })
      }

      useEffect(function () {
        aliveRef.current = true
        load(false)
        var poll = window.setInterval(function () {
          load(false)
        }, POLL_MS)
        return function () {
          aliveRef.current = false
          window.clearInterval(poll)
        }
        // Refetch whenever the requested range or account changes.
      }, [rangeKey, accountKey])

      return { payload: payload, error: error, busy: busy, reload: load }
    }

    function smallButton(label, title, onClick) {
      return h(
        'button',
        {
          type: 'button',
          title: title,
          onClick: onClick,
          style: {
            appearance: 'none',
            border: HAIRLINE,
            background: 'transparent',
            color: 'inherit',
            borderRadius: 6,
            cursor: 'pointer',
            font: 'inherit',
            fontSize: 11,
            lineHeight: '16px',
            padding: '1px 6px',
            opacity: 0.85,
          },
        },
        label,
      )
    }

    function limitRow(limit, now, first) {
      var percent = limit.percentUsed
      var color = barColor(percent)
      var remaining = formatRemaining(limit.resetsAt, now)
      return h(
        'div',
        {
          key: limit.type,
          style: {
            padding: first ? '2px 0 9px' : '9px 0',
            borderTop: first ? 'none' : DIVIDER,
          },
        },
        h(
          'div',
          { style: { display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 8 } },
          h('span', { style: { fontSize: 12, fontWeight: 600 } }, limit.label),
          h('span', { style: { fontSize: 13, fontWeight: 700, color: color } }, formatPercent(percent)),
        ),
        h(
          'div',
          { style: { marginTop: 6, height: 5, borderRadius: 3, background: TRACK, overflow: 'hidden' } },
          h('div', {
            style: {
              width: Math.max(0, Math.min(100, typeof percent === 'number' ? percent : 0)) + '%',
              height: '100%',
              background: color,
              borderRadius: 3,
              transition: 'width 240ms ease',
            },
          }),
        ),
        remaining
          ? h(
              'div',
              { style: { marginTop: 5, fontSize: 10, color: MUTED, display: 'flex', alignItems: 'center', gap: 4 } },
              icon('clock', 11, MUTED),
              h('span', null, '重置还有 ' + remaining),
            )
          : null,
      )
    }

    /** One-line summary used as the chip's tooltip. */
    function summarise(payload) {
      if (!payload || !payload.limits) return CHIP_TITLE
      var head = CHIP_TITLE
      if (payload.account && payload.accounts && payload.accounts.length > 1) {
        head += '（' + payload.account.label + '）'
      }
      var parts = payload.limits.map(function (limit) {
        return limit.label + ' ' + formatPercent(limit.percentUsed)
      })
      if (typeof payload.creditsUsd === 'number') {
        parts.push('Credits $' + payload.creditsUsd.toFixed(4))
      }
      if (payload.tokens && payload.tokens.rangeTotals) {
        var tokens = payload.tokens
        parts.push(
          tokens.range.from + '~' + tokens.range.to + ' ' + formatTokens(tokens.rangeTotals.total) + ' tokens',
        )
      }
      return head + '：' + parts.join(' · ')
    }

    /** One rolling-window token total. */
    function tokenRow(label, entry, hint) {
      return h(
        'div',
        {
          key: label,
          style: {
            display: 'flex',
            alignItems: 'baseline',
            justifyContent: 'space-between',
            gap: 8,
            marginTop: 5,
          },
        },
        h('span', { style: { fontSize: 11, opacity: 0.85 } }, label),
        h(
          'span',
          { style: { fontSize: 11, textAlign: 'right' } },
          h('span', { style: { fontWeight: 600 } }, formatTokens(entry && entry.total)),
          h('span', { style: { fontSize: 10, color: MUTED } }, ' tokens'),
          hint ? h('span', { style: { fontSize: 10, color: MUTED } }, ' · ' + hint) : null,
        ),
      )
    }

    /** Collapsed-state persistence key for the token block. */
    var TOKENS_KEY = 'dsh.cline-quota.tokens-collapsed'

    /** Whether the token block is expanded; folded by default. */
    function readTokensOpen() {
      try {
        return window.localStorage.getItem(TOKENS_KEY) === '0'
      } catch (error) {
        return false
      }
    }

    function writeTokensOpen(open) {
      try {
        window.localStorage.setItem(TOKENS_KEY, open ? '0' : '1')
      } catch (error) {
        /* private mode: the preference simply does not persist */
      }
    }

    /** Which account the panel last showed, so a reload keeps the choice. */
    var ACCOUNT_KEY = 'dsh.cline-quota.account'

    function readAccount() {
      try {
        return window.localStorage.getItem(ACCOUNT_KEY) || null
      } catch (error) {
        return null
      }
    }

    function writeAccount(label) {
      try {
        if (label) window.localStorage.setItem(ACCOUNT_KEY, label)
        else window.localStorage.removeItem(ACCOUNT_KEY)
      } catch (error) {
        /* private mode: the preference simply does not persist */
      }
    }

    /** Short label for the token block's current window. */
    function rangeLabel(tokens) {
      if (!tokens || !tokens.range) return ''
      return tokens.mode === 'rolling24h' ? '近 24 小时' : tokens.range.days + ' 天'
    }

    /** A native date input styled to sit in the popover. */
    function dateInput(value, max, onChange) {
      return h('input', {
        type: 'date',
        value: value,
        max: max,
        onChange: function (event) {
          onChange(event.target.value)
        },
        style: {
          flex: 1,
          minWidth: 0,
          fontSize: 11,
          fontFamily: 'inherit',
          padding: '2px 0',
          border: 'none',
          background: 'transparent',
          color: 'inherit',
          colorScheme: 'light dark',
        },
      })
    }

    /**
     * The token-consumption block: a range picker, the range's bar series, the
     * rolling five-hour window, and the leading models.
     * @param tokens - the host's `tokens` section.
     * @param controls - `{ from, to, max, setRange, reset }` for the picker.
     */
    function tokenBlock(tokens, controls) {
      if (!tokens || !Array.isArray(tokens.series) || tokens.series.length === 0) return null
      var totals = tokens.rangeTotals || {}
      var rolling = tokens.mode === 'rolling24h'
      var models = Array.isArray(tokens.models) ? tokens.models : []
      // The selected model's own slice of the window when the host sent one;
      // with nothing selected the block shows every model, as before.
      var picked = null
      for (var modelIndex = 0; modelIndex < models.length; modelIndex++) {
        if (models[modelIndex].model === controls.model) picked = models[modelIndex]
      }
      var shown = picked || totals
      var series =
        picked && Array.isArray(picked.series) && picked.series.length ? picked.series : tokens.series
      var max =
        series.reduce(function (top, point) {
          return Math.max(top, point.total || 0)
        }, 0) || 1

      var header = h(
        'div',
        {
          role: 'button',
          tabIndex: 0,
          title: controls.open ? '收起 Token 消耗' : '展开 Token 消耗',
          onClick: controls.toggle,
          style: {
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            cursor: 'pointer',
            userSelect: 'none',
          },
        },
        h('span', { style: { fontSize: 13, fontWeight: 700 } }, 'Token 消耗'),
        h('span', { style: { flex: 1 } }),
        controls.open
          ? null
          : h('span', { style: { fontSize: 10, color: MUTED } }, rangeLabel(tokens) + ' ' + formatTokens(shown.total)),
        tokens.scope === 'cline-pass'
          ? h(
              'span',
              { title: '只统计 ClinePass 订阅的用量，其他 provider 另行计费', style: { display: 'flex' } },
              pill('仅 ClinePass'),
            )
          : null,
        h('span', { style: { fontSize: 9, color: MUTED } }, controls.open ? '▾' : '▸'),
      )

      var summaryLeft = rolling
        ? '近 24 小时'
        : tokens.range.days + ' 天' + (tokens.seriesUnit === 'week' ? '（按周）' : '')
      var summaryRight = controls.stale
        ? '读取中…'
        : '截至 ' + (rolling ? formatClock(tokens.range.to) || tokens.range.to : tokens.range.to)
      var axisLabel = function (point) {
        if (!point) return ''
        var text = String(point.label || point.date || '')
        return rolling ? text : text.slice(5, 10)
      }
      var axisLabels = [
        axisLabel(series[0]),
        axisLabel(series[Math.floor((series.length - 1) / 2)]),
        axisLabel(series[series.length - 1]),
      ]

      var body = controls.open
        ? [
            h(
              'div',
              {
                key: 'presets',
                style: {
                  display: 'flex',
                  gap: 3,
                  marginTop: 9,
                  padding: 3,
                  borderRadius: 10,
                  background: 'color-mix(in srgb, currentColor 7%, transparent)',
                },
              },
              [
                { key: '24h', label: '24h', active: rolling, run: controls.preset24h },
                { key: '7', label: '7 天', active: controls.presetDays === 7, run: function () { controls.preset(7) } },
                {
                  key: '14',
                  label: '14 天',
                  active: controls.presetDays === 14,
                  run: function () { controls.preset(14) },
                },
                {
                  key: '30',
                  label: '30 天',
                  active: controls.presetDays === 30,
                  run: function () { controls.preset(30) },
                },
              ].map(function (preset) {
                return h(
                  'button',
                  {
                    key: preset.key,
                    type: 'button',
                    onClick: preset.run,
                    style: {
                      appearance: 'none',
                      flex: 1,
                      border: 'none',
                      background: preset.active ? 'var(--dsw-alias-bg-layer-1, Canvas)' : 'transparent',
                      color: 'inherit',
                      borderRadius: 8,
                      cursor: 'pointer',
                      font: 'inherit',
                      fontSize: 11,
                      fontWeight: preset.active ? 600 : 400,
                      lineHeight: '16px',
                      padding: '4px 0',
                      boxShadow: preset.active ? '0 1px 2px rgba(0,0,0,0.16)' : 'none',
                    },
                  },
                  preset.label,
                )
              }),
            ),

            h(
              'div',
              { key: 'picker', style: { display: 'flex', alignItems: 'center', gap: 6, marginTop: 8 } },
              h(
                'div',
                {
                  style: {
                    flex: 1,
                    minWidth: 0,
                    display: 'flex',
                    alignItems: 'center',
                    gap: 5,
                    padding: '2px 7px',
                    borderRadius: 9,
                    border: CARD_BORDER,
                  },
                },
                h('span', { style: { flex: 'none', color: MUTED, display: 'flex' } }, icon('calendar', 13)),
                dateInput(controls.from, controls.max, function (value) {
                  controls.setRange({ from: value, to: controls.to })
                }),
                h('span', { style: { flex: 'none', fontSize: 10, color: MUTED } }, '→'),
                dateInput(controls.to, controls.max, function (value) {
                  controls.setRange({ from: controls.from, to: value })
                }),
              ),
              h(
                'button',
                {
                  key: 'reset',
                  type: 'button',
                  title: '回到默认区间',
                  onClick: controls.reset,
                  style: {
                    appearance: 'none',
                    flex: 'none',
                    width: 30,
                    height: 30,
                    padding: 0,
                    borderRadius: 10,
                    border: CARD_BORDER,
                    background: 'transparent',
                    color: 'inherit',
                    cursor: 'pointer',
                    opacity: controls.explicit ? 1 : 0.45,
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                  },
                },
                icon('refresh', 14),
              ),
            ),

            h(
              'div',
              { key: 'summary', style: { marginTop: 10 } },
              h(
                'div',
                {
                  style: {
                    display: 'flex',
                    alignItems: 'baseline',
                    justifyContent: 'space-between',
                    gap: 8,
                    fontSize: 10,
                    color: MUTED,
                  },
                },
                h('span', null, summaryLeft),
                h('span', { style: { whiteSpace: 'nowrap' } }, summaryRight),
              ),
              h(
                'div',
                { style: { marginTop: 3, display: 'flex', alignItems: 'baseline', gap: 6 } },
                h(
                  'span',
                  { style: { fontSize: 26, fontWeight: 700, lineHeight: 1.15, letterSpacing: '-0.02em' } },
                  formatTokens(shown.total),
                ),
                h('span', { style: { fontSize: 11, color: MUTED } }, 'tokens'),
                h('span', { style: { flex: 1 } }),
                typeof shown.costUsd === 'number' ? pill('$' + shown.costUsd.toFixed(4), 'green') : null,
              ),
            ),

            h(
              'div',
              {
                key: 'chart',
                style: {
                  marginTop: 10,
                  opacity: controls.stale ? 0.45 : 1,
                  transition: 'opacity 120ms linear',
                },
              },
              h(
                'div',
                {
                  style: {
                    display: 'flex',
                    alignItems: 'flex-end',
                    gap: 3,
                    height: 52,
                    paddingBottom: 1,
                    borderBottom: '1px dashed color-mix(in srgb, currentColor 18%, transparent)',
                  },
                },
                series.map(function (point) {
                  var height = point.total > 0 ? Math.max(3, Math.round((point.total / max) * 52)) : 2
                  var cost = point.costUsd ? '（$' + (point.costUsd / 1e8).toFixed(4) + '）' : ''
                  return h('div', {
                    key: point.date,
                    title: (point.label || point.date) + '：' + formatTokens(point.total) + ' tokens' + cost,
                    style: {
                      flex: 1,
                      height: height + 'px',
                      borderRadius: 3,
                      background: point.total > 0 ? GREEN : TRACK,
                    },
                  })
                }),
              ),
              h(
                'div',
                {
                  style: {
                    marginTop: 4,
                    display: 'flex',
                    justifyContent: 'space-between',
                    fontSize: 9,
                    color: MUTED,
                  },
                },
                h('span', null, axisLabels[0]),
                h('span', null, axisLabels[1]),
                h('span', null, axisLabels[2]),
              ),
            ),

            models.length
              ? h(
                  'div',
                  {
                    key: 'models',
                    style: {
                      marginTop: 10,
                      opacity: controls.stale ? 0.45 : 1,
                      transition: 'opacity 120ms linear',
                    },
                  },
                  h(
                    'div',
                    { style: { display: 'flex', alignItems: 'center', gap: 8 } },
                    h('span', { style: { flex: 1, fontSize: 11, color: MUTED } }, '主要模型'),
                    picked
                      ? h(
                          'button',
                          {
                            type: 'button',
                            onClick: function () {
                              controls.setModel(null)
                            },
                            style: {
                              appearance: 'none',
                              border: 'none',
                              background: 'transparent',
                              color: MUTED,
                              cursor: 'pointer',
                              font: 'inherit',
                              fontSize: 10,
                              padding: 0,
                            },
                          },
                          '看全部',
                        )
                      : null,
                  ),
                  models.map(function (entry, index) {
                    var isPicked = Boolean(picked) && picked.model === entry.model
                    return h(
                      'div',
                      {
                        key: entry.model,
                        role: 'button',
                        tabIndex: 0,
                        title: '只看 ' + String(entry.model).replace(/^cline-pass\//, '') + '（再点一次看全部）',
                        onClick: function () {
                          controls.setModel(isPicked ? null : entry.model)
                        },
                        style: {
                          display: 'flex',
                          alignItems: 'center',
                          gap: 8,
                          marginTop: 5,
                          padding: '3px 6px',
                          marginLeft: -6,
                          marginRight: -6,
                          borderRadius: 7,
                          cursor: 'pointer',
                          background: isPicked ? 'color-mix(in srgb, currentColor 7%, transparent)' : 'transparent',
                        },
                      },
                      h('span', {
                        style: {
                          flex: 'none',
                          width: 7,
                          height: 7,
                          borderRadius: '50%',
                          background: DOT_COLORS[index % DOT_COLORS.length],
                        },
                      }),
                      h(
                        'span',
                        {
                          style: {
                            flex: 1,
                            minWidth: 0,
                            fontSize: 11,
                            fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
                            overflow: 'hidden',
                            textOverflow: 'ellipsis',
                            whiteSpace: 'nowrap',
                          },
                        },
                        String(entry.model).replace(/^cline-pass\//, ''),
                      ),
                      h('span', { style: { flex: 'none', fontSize: 12, fontWeight: 700 } }, formatTokens(entry.total)),
                    )
                  }),
                )
              : tokens.topModels && tokens.topModels.length
                ? h(
                    'div',
                    { key: 'models', style: { marginTop: 10 } },
                    h('div', { style: { fontSize: 11, color: MUTED } }, '主要模型'),
                    tokens.topModels.map(function (model, index) {
                      return h(
                        'div',
                        {
                          key: model.model,
                          style: { display: 'flex', alignItems: 'center', gap: 8, marginTop: 5 },
                        },
                        h('span', {
                          style: {
                            flex: 'none',
                            width: 7,
                            height: 7,
                            borderRadius: '50%',
                            background: DOT_COLORS[index % DOT_COLORS.length],
                          },
                        }),
                        h(
                          'span',
                          {
                            style: {
                              flex: 1,
                              minWidth: 0,
                              fontSize: 11,
                              fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
                              overflow: 'hidden',
                              textOverflow: 'ellipsis',
                              whiteSpace: 'nowrap',
                            },
                          },
                          String(model.model).replace(/^cline-pass\//, ''),
                        ),
                        h('span', { style: { flex: 'none', fontSize: 12, fontWeight: 700 } }, formatTokens(model.total)),
                      )
                    }),
                  )
                : null,
          ]
        : null

      return h(
        'div',
        { style: { marginTop: 10, paddingTop: 10, borderTop: HAIRLINE } },
        header,
        body,
      )
    }

    /** The popover body: all three windows, the plan, the credits, and tokens. */
    function QuotaPopover(props) {
      var payload = props.payload
      var error = props.error
      var busy = props.busy
      var now = props.now
      var reload = props.reload
      var controls = props.controls

      var limits = (payload && payload.limits) || []
      var plan = payload && payload.plan
      var credits = payload && typeof payload.creditsUsd === 'number' ? payload.creditsUsd : null
      var accounts = (payload && payload.accounts) || []
      var current = (payload && payload.account) || accounts[0] || null
      // The control follows the *requested* account, so it never flicks back
      // while the switched account is still loading.
      var shownLabel = controls.account || (current && current.label) || ''
      var shownEntry = null
      var nextAccountLabel = ''
      for (var accountIndex = 0; accountIndex < accounts.length; accountIndex++) {
        if (accounts[accountIndex].label === shownLabel) {
          shownEntry = accounts[accountIndex]
          nextAccountLabel = accounts[(accountIndex + 1) % accounts.length].label
        }
      }
      if (nextAccountLabel === '' && accounts.length > 0) nextAccountLabel = accounts[0].label
      var accountTitle =
        (shownEntry ? shownEntry.label + ' · ' + shownEntry.keyRef : shownLabel) +
        (current && current.email ? ' · ' + current.email : '')

      return h(
        'div',
        {
          style: {
            position: 'fixed',
            top: props.top,
            right: props.right,
            zIndex: 60,
            width: 300,
            // The token block makes the popover taller than the viewport on a
            // short window, so it scrolls rather than running off-screen.
            maxHeight: 'min(72vh, 560px)',
            overflowY: 'auto',
            padding: '11px 12px 12px',
            borderRadius: 12,
            border: HAIRLINE,
            background: 'var(--dsw-alias-bg-layer-1, Canvas)',
            color: 'inherit',
            boxShadow: '0 8px 28px rgba(0,0,0,0.28)',
            font: 'inherit',
            fontSize: 12,
            lineHeight: 1.35,
            textAlign: 'left',
          },
        },

        h(
          'div',
          { style: { display: 'flex', alignItems: 'center', gap: 9 } },
          tile('gauge', 32),
          h(
            'div',
            { style: { flex: 1, minWidth: 0 } },
            h('div', { style: { fontSize: 15, fontWeight: 700 } }, CHIP_TITLE),
            plan && plan.name
              ? h(
                  'div',
                  {
                    style: {
                      marginTop: 1,
                      fontSize: 10,
                      color: MUTED,
                      whiteSpace: 'nowrap',
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                    },
                  },
                  String(plan.name).replace(/\s*\([^)]*\)\s*/, ' ').trim() +
                    (plan.interval ? ' · ' + plan.interval : ''),
                )
              : null,
          ),
          busy ? h('span', { style: { fontSize: 11, color: MUTED, whiteSpace: 'nowrap' } }, '刷新中') : null,
          h(
            'button',
            {
              type: 'button',
              title: '立即刷新',
              onClick: function () {
                reload(true)
              },
              style: {
                appearance: 'none',
                flex: 'none',
                width: 30,
                height: 30,
                padding: 0,
                borderRadius: 10,
                border: CARD_BORDER,
                background: 'transparent',
                color: 'inherit',
                cursor: 'pointer',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
              },
            },
            icon('refresh', 15),
          ),
        ),

        h(
          'div',
          { style: { display: 'flex', alignItems: 'center', gap: 8, marginTop: 9 } },
          h('span', { style: { flex: 'none', color: MUTED, display: 'flex' } }, icon('user', 14)),
          h(
            'span',
            {
              style: {
                flex: 1,
                minWidth: 0,
                fontSize: 11,
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
              },
              title: accountTitle,
            },
            shownLabel + (shownEntry && !shownEntry.configured ? '（未配置）' : ''),
          ),
          shownEntry && shownEntry.source === 'stored'
            ? iconButton('x', '从凭据库移除这个账号', function () {
                controls.removeAccount(shownEntry.label)
              })
            : null,
          accounts.length > 1
            ? iconButton('switch', '切换到下一个账号（共 ' + accounts.length + ' 个）', function () {
                controls.setAccount(nextAccountLabel)
              })
            : null,
          iconButton(controls.keyEntry ? 'x' : 'plus', controls.keyEntry ? '收起' : '粘贴 API key 添加账号', function () {
            controls.toggleKeyEntry()
          }),
        ),

        controls.keyEntry
          ? h(
              'div',
              { style: { marginTop: 7 } },
              h(
                'div',
                { style: { display: 'flex', alignItems: 'center', gap: 6 } },
                h('input', {
                  type: 'password',
                  value: controls.keyDraft,
                  placeholder: '粘贴 Cline API key',
                  autoFocus: true,
                  onChange: function (event) {
                    controls.setKeyDraft(event.target.value)
                  },
                  onKeyDown: function (event) {
                    if (event.key === 'Enter') controls.saveKey()
                    if (event.key === 'Escape') controls.toggleKeyEntry()
                  },
                  style: {
                    flex: 1,
                    minWidth: 0,
                    fontSize: 11,
                    fontFamily: 'inherit',
                    padding: '4px 7px',
                    borderRadius: 9,
                    border: CARD_BORDER,
                    background: 'transparent',
                    color: 'inherit',
                  },
                }),
                h(
                  'button',
                  {
                    type: 'button',
                    onClick: controls.saveKey,
                    disabled: controls.keyBusy,
                    style: {
                      appearance: 'none',
                      flex: 'none',
                      border: '1px solid ' + GREEN,
                      background: GREEN,
                      color: '#fff',
                      borderRadius: 9,
                      cursor: controls.keyBusy ? 'default' : 'pointer',
                      font: 'inherit',
                      fontSize: 11,
                      lineHeight: '16px',
                      padding: '4px 10px',
                      opacity: controls.keyBusy ? 0.7 : 1,
                    },
                  },
                  controls.keyBusy ? '保存中…' : '保存',
                ),
              ),
              controls.keyError
                ? h(
                    'div',
                    { style: { marginTop: 5, fontSize: 10, color: RED, wordBreak: 'break-word' } },
                    controls.keyError,
                  )
                : null,
              h(
                'div',
                { style: { marginTop: 5, fontSize: 10, color: MUTED } },
                'key 会写进 DSH 凭据库（$DSH_HOME/.credentials.yaml），插件只记引用名',
              ),
            )
          : null,

        error ? h('div', { style: { marginTop: 9, fontSize: 11, color: RED, wordBreak: 'break-word' } }, error) : null,

        limits.length
          ? h(
              'div',
              { style: { marginTop: 8 } },
              limits.map(function (limit, index) {
                return limitRow(limit, now, index === 0)
              }),
            )
          : !error
            ? h('div', { style: { marginTop: 9, fontSize: 11, color: MUTED } }, '读取中…')
            : null,

        h(
          'div',
          {
            style: {
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              marginTop: 2,
              paddingTop: 10,
              borderTop: DIVIDER,
            },
          },
          h('span', { style: { flex: 'none', color: MUTED, display: 'flex' } }, icon('card', 15)),
          h('span', { style: { flex: 'none', fontSize: 12, fontWeight: 600 } }, 'Credits'),
          pill('按量付费'),
          h('span', { style: { flex: 1 } }),
          h('span', { style: { fontSize: 14, fontWeight: 700 } }, credits === null ? '—' : '$' + credits.toFixed(4)),
        ),

        tokenBlock(payload && payload.tokens, controls),

        payload && payload.fetchedAt
          ? h(
              'div',
              {
                style: {
                  marginTop: 10,
                  fontSize: 10,
                  color: MUTED,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  gap: 5,
                },
              },
              h('span', { style: { width: 6, height: 6, borderRadius: '50%', background: GREEN } }),
              h('span', null, '更新于 ' + (formatClock(payload.fetchedAt) || payload.fetchedAt)),
            )
          : null,
      )
    }

    /**
     * The session-header chip. It owns its data, its popover, and the outside
     * click / Escape handling; the header row owns the layout.
     */
    function ClineQuotaChip() {
      var rangePair = useState(null)
      var range = rangePair[0]
      var setRange = rangePair[1]

      var tokensOpenPair = useState(readTokensOpen)
      var tokensOpen = tokensOpenPair[0]
      var setTokensOpen = tokensOpenPair[1]

      // Which model the token block shows; null means every model.
      var modelPair = useState(null)
      var selectedModel = modelPair[0]
      var setSelectedModel = modelPair[1]

      // Which account the whole panel reads; null means the host's first one.
      var accountPair = useState(readAccount)
      var selectedAccount = accountPair[0]
      var setSelectedAccount = accountPair[1]

      function chooseAccount(label) {
        setSelectedAccount(label || null)
        writeAccount(label || null)
      }

      // The key-entry panel: paste a key, validate it, store it in the harness's
      // credential store, then switch to the account it belongs to.
      var keyEntryPair = useState(false)
      var keyEntry = keyEntryPair[0]
      var setKeyEntry = keyEntryPair[1]

      var keyDraftPair = useState('')
      var keyDraft = keyDraftPair[0]
      var setKeyDraft = keyDraftPair[1]

      var keyBusyPair = useState(false)
      var keyBusy = keyBusyPair[0]
      var setKeyBusy = keyBusyPair[1]

      var keyErrorPair = useState(null)
      var keyError = keyErrorPair[0]
      var setKeyError = keyErrorPair[1]

      function saveKey() {
        var value = keyDraft.trim()
        if (value === '' || keyBusy) return
        setKeyBusy(true)
        setKeyError(null)
        postJson(KEY_ENDPOINT, { key: value }).then(function (result) {
          setKeyBusy(false)
          if (!result || !result.ok) {
            setKeyError((result && result.error) || '保存失败')
            return
          }
          setKeyDraft('')
          setKeyEntry(false)
          var label = (result.account && result.account.label) || null
          setSelectedAccount(label)
          writeAccount(label)
          // The new account only exists for the next fetch.
          quota.reload(true)
        })
      }

      function removeAccount(label) {
        postJson(KEY_REMOVE_ENDPOINT, { label: label }).then(function () {
          setSelectedAccount(null)
          writeAccount(null)
          quota.reload(true)
        })
      }

      var quota = useQuota(range, selectedAccount)

      var openPair = useState(false)
      var open = openPair[0]
      var setOpen = openPair[1]

      var anchorPair = useState({ top: 0, right: 12 })
      var anchor = anchorPair[0]
      var setAnchor = anchorPair[1]

      var nowPair = useState(Date.now())
      var now = nowPair[0]
      var setNow = nowPair[1]

      var rootRef = useRef(null)

      // The range the host actually resolved: the picker mirrors it, and the
      // presets count back from the API's own current day.
      var resolvedRange = (quota.payload && quota.payload.tokens && quota.payload.tokens.range) || null
      var rolling = Boolean((range && range.window) || (quota.payload && quota.payload.tokens && quota.payload.tokens.mode === 'rolling24h'))
      var shownFrom = rolling
        ? (resolvedRange && resolvedRange.dayFrom) || ''
        : (range && range.from) || (resolvedRange && resolvedRange.from) || ''
      var shownTo = rolling
        ? (resolvedRange && resolvedRange.dayTo) || ''
        : (range && range.to) || (resolvedRange && resolvedRange.to) || ''

      // The preset the user asked for, so the control answers on click instead of
      // waiting for the payload to come back.
      var requestedDays =
        range && range.from && range.to
          ? Math.round((Date.parse(range.to + 'T00:00:00Z') - Date.parse(range.from + 'T00:00:00Z')) / 86400000) + 1
          : null
      var activeDays =
        rolling ? null : requestedDays !== null ? requestedDays : (resolvedRange && resolvedRange.days) || null

      // True while the payload still describes the previous range: the block dims
      // its data, so a slow switch does not look like a dead click.
      var stale =
        Boolean(quota.payload && quota.payload.tokens) &&
        (rolling !== (quota.payload.tokens.mode === 'rolling24h') ||
          (!rolling && resolvedRange && (resolvedRange.from !== shownFrom || resolvedRange.to !== shownTo)))

      function preset(days) {
        var last = (resolvedRange && resolvedRange.max) || new Date().toISOString().slice(0, 10)
        var first = new Date(Date.parse(last + 'T00:00:00Z') - (days - 1) * 86400000).toISOString().slice(0, 10)
        setRange({ from: first, to: last })
      }

      var controls = {
        from: shownFrom,
        to: shownTo,
        max: (resolvedRange && resolvedRange.max) || undefined,
        mode: rolling ? 'rolling24h' : 'range',
        presetDays: activeDays,
        stale: stale,
        explicit: Boolean(range) || Boolean(resolvedRange && resolvedRange.explicit),
        setRange: setRange,
        preset: preset,
        preset24h: function () {
          setRange({ window: '24h' })
        },
        reset: function () {
          setRange(null)
        },
        model: selectedModel,
        setModel: setSelectedModel,
        account: selectedAccount,
        setAccount: chooseAccount,
        keyEntry: keyEntry,
        keyDraft: keyDraft,
        setKeyDraft: setKeyDraft,
        keyBusy: keyBusy,
        keyError: keyError,
        saveKey: saveKey,
        removeAccount: removeAccount,
        toggleKeyEntry: function () {
          setKeyError(null)
          setKeyEntry(!keyEntry)
        },
        open: tokensOpen,
        toggle: function () {
          var next = !tokensOpen
          setTokensOpen(next)
          writeTokensOpen(next)
        },
      }

      // Report the mount once, so the host can confirm the chip really rendered
      // in a running client (not just that the bundle was served).
      useEffect(function () {
        beacon('mounted')
      }, [])

      // Countdowns only need to tick while the popover is visible.
      useEffect(
        function () {
          if (!open) return undefined
          var tick = window.setInterval(function () {
            setNow(Date.now())
          }, 30000)
          return function () {
            window.clearInterval(tick)
          }
        },
        [open],
      )

      useEffect(
        function () {
          if (!open) return undefined
          var onPointerDown = function (event) {
            var root = rootRef.current
            if (root && event.target instanceof Node && root.contains(event.target)) return
            setOpen(false)
          }
          var onKeyDown = function (event) {
            if (event.key === 'Escape') setOpen(false)
          }
          document.addEventListener('mousedown', onPointerDown)
          document.addEventListener('keydown', onKeyDown)
          return function () {
            document.removeEventListener('mousedown', onPointerDown)
            document.removeEventListener('keydown', onKeyDown)
          }
        },
        [open],
      )

      function toggle() {
        if (open) {
          setOpen(false)
          return
        }
        // Measure the chip and place the popover with fixed coordinates: an
        // ancestor's overflow can then never clip it.
        var element = rootRef.current
        if (element && typeof element.getBoundingClientRect === 'function') {
          var rect = element.getBoundingClientRect()
          var viewport = typeof window !== 'undefined' && window.innerWidth ? window.innerWidth : 0
          setAnchor({ top: Math.round(rect.bottom + 6), right: Math.max(8, Math.round(viewport - rect.right)) })
        }
        setNow(Date.now())
        setOpen(true)
      }

      var limits = (quota.payload && quota.payload.limits) || []
      var fiveHour = null
      for (var i = 0; i < limits.length; i++) {
        if (limits[i].type === 'five_hour') fiveHour = limits[i]
      }
      var percent = fiveHour ? fiveHour.percentUsed : null
      var color = quota.error ? RED : barColor(percent)
      var label = quota.error ? '!' : percent === null ? '…' : formatPercent(percent)

      return h(
        'span',
        { ref: rootRef, style: { position: 'relative', display: 'inline-flex' } },
        h(
          'button',
          {
            type: 'button',
            title: summarise(quota.payload),
            onClick: toggle,
            'aria-expanded': open,
            style: {
              appearance: 'none',
              display: 'inline-flex',
              alignItems: 'center',
              gap: 6,
              height: 24,
              padding: '0 9px',
              borderRadius: 999,
              border: HAIRLINE,
              background: open ? 'color-mix(in srgb, currentColor 12%, transparent)' : CHIP_BG,
              color: 'inherit',
              font: 'inherit',
              fontSize: 12,
              lineHeight: 1,
              cursor: 'pointer',
              whiteSpace: 'nowrap',
            },
          },
          h('span', {
            style: {
              width: 6,
              height: 6,
              borderRadius: 999,
              background: color,
              flex: 'none',
            },
          }),
          h('span', { style: { opacity: 0.75 } }, 'Cline'),
          h('span', { style: { fontWeight: 600, color: color } }, label),
        ),
        open
          ? h(QuotaPopover, {
              top: anchor.top,
              right: anchor.right,
              payload: quota.payload,
              error: quota.error,
              busy: quota.busy,
              now: now,
              reload: quota.reload,
              controls: controls,
            })
          : null,
      )
    }

    /** Required client services: the slot registry this entry registers into. */
    var inject = ['slots']

    /**
     * Client plugin body.
     * @param ctx - client root context.
     */
    function apply(ctx) {
      ctx.effect(function () {
        return ctx.slots.inject('conversation.session.header.utilities', function () {
          return ctx.slots.register(
            { name: 'conversation.session.header.utilities', id: CHIP_ID, order: 10 },
            ClineQuotaChip,
          )
        })
      }, 'cline-quota: header utility')

      // Reaching here means the bundle executed and the registration ran.
      beacon('applied', { inject: inject, slot: 'conversation.session.header.utilities' })

      // Warm the host's cache once so the popover paints data on first open
      // instead of a loading state, and report what came back: the beacon is
      // the only way to confirm the client -> host -> Cline path from inside a
      // running GUI.
      requestQuota(false, null).then(function (result) {
        var tokens = result && result.tokens
        beacon('prefetched', {
          ok: !!(result && result.ok),
          error: result && result.error ? String(result.error).slice(0, 200) : undefined,
          limits:
            result && result.limits
              ? result.limits.map(function (limit) {
                  return limit.type + '=' + limit.percentUsed
                })
              : undefined,
          creditsUsd: result ? result.creditsUsd : undefined,
          tokens: tokens
            ? {
                range: tokens.range && tokens.range.from + '..' + tokens.range.to,
                rangeDays: tokens.range && tokens.range.days,
                seriesUnit: tokens.seriesUnit,
                rangeTotal: tokens.rangeTotals && tokens.rangeTotals.total,
                fiveHours: tokens.fiveHours && tokens.fiveHours.total,
                requests: tokens.fiveHours && tokens.fiveHours.requests,
                complete: tokens.fiveHours && tokens.fiveHours.complete,
              }
            : undefined,
        })
      })
    }

    return { apply: apply, inject: inject }
  },
})
