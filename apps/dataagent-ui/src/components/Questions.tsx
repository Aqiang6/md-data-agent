/** Browser answers for the harness user-question service. */
import { useEffect, useState } from 'react'
import { Send } from 'lucide-react'
import { Markdown } from './Markdown.tsx'
import { t } from '../copy.ts'

interface Question {
  id: string
  question: string
  detail?: string
  options?: Array<{ label: string; description?: string }>
  multiSelect?: boolean
}
interface Request {
  requestId: string
  questions: Question[]
}

/** Show pending clarification without sending an unrelated model prompt. */
export function Questions({ sessionId }: { sessionId: string }) {
  const [requests, setRequests] = useState<Request[]>([])
  const [answers, setAnswers] = useState<Record<string, { selected: string[]; custom: string }>>({})
  const [error, setError] = useState<string>()
  const [sending, setSending] = useState(false)
  useEffect(() => {
    const controller = new AbortController()
    let timer: ReturnType<typeof setTimeout>
    const read = async (): Promise<void> => {
      try {
        const response = await fetch(`/api/data-agent/questions?sessionId=${encodeURIComponent(sessionId)}`, {
          signal: controller.signal,
        })
        if (!response.ok) throw new Error(t('unavailable'))
        const value = (await response.json()) as { requests: Request[] }
        setRequests(value.requests)
      } catch (cause) {
        if (!controller.signal.aborted) setError(String(cause))
      } finally {
        if (!controller.signal.aborted)
          timer = setTimeout(() => {
            void read()
          }, 1000)
      }
    }
    void read()
    return () => {
      controller.abort()
      clearTimeout(timer)
    }
  }, [sessionId])
  if (!requests.length) return null
  const update = (id: string, selected: string[], custom: string): void => {
    setAnswers(previous => ({ ...previous, [id]: { selected, custom } }))
  }
  const submit = async (request: Request): Promise<void> => {
    setSending(true)
    setError(undefined)
    try {
      const response = await fetch('/api/data-agent/answer', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          sessionId,
          requestId: request.requestId,
          answers: request.questions.map(question => ({
            id: question.id,
            ...(answers[`${request.requestId}:${question.id}`] ?? { selected: [], custom: '' }),
          })),
        }),
      })
      const value = (await response.json()) as { error?: string }
      if (!response.ok) throw new Error(value.error ?? t('unavailable'))
      setRequests(previous => previous.filter(item => item.requestId !== request.requestId))
    } catch (cause) {
      setError(String(cause))
    } finally {
      setSending(false)
    }
  }
  return (
    <section className="questions" aria-label={t('clarification')}>
      {requests.map(request => (
        <form
          key={request.requestId}
          onSubmit={(event) => {
            event.preventDefault()
            void submit(request)
          }}
        >
          {request.questions.map((question) => {
            const key = `${request.requestId}:${question.id}`
            const answer = answers[key] ?? { selected: [], custom: '' }
            return (
              <fieldset key={key}>
                <legend>{question.question}</legend>
                {question.detail && <Markdown text={question.detail} />}
                <div className="question-options">
                  {question.options?.map(option => (
                    <label key={option.label}>
                      <input
                        type={question.multiSelect ? 'checkbox' : 'radio'}
                        name={key}
                        checked={answer.selected.includes(option.label)}
                        onChange={(event) => {
                          const selected = question.multiSelect
                            ? event.target.checked
                              ? [...answer.selected, option.label]
                              : answer.selected.filter(label => label !== option.label)
                            : [option.label]
                          update(key, selected, answer.custom)
                        }}
                      />
                      <span>
                        {option.label}
                        {option.description && <small>{option.description}</small>}
                      </span>
                    </label>
                  ))}
                </div>
                <textarea
                  aria-label={t('customAnswer')}
                  value={answer.custom}
                  onChange={(event) => {
                    update(key, answer.selected, event.target.value)
                  }}
                />
              </fieldset>
            )
          })}
          {error && <p role="alert">{error}</p>}
          <button type="submit" disabled={sending}>
            <Send size={14} />
            {t('answer')}
          </button>
        </form>
      ))}
    </section>
  )
}
