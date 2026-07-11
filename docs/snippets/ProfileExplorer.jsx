/**
 * Interactive explanation of the deterministic beginner profile.
 * Profile text and explanation metadata are passed from the parent MDX page.
 */
export const ProfileExplorer = ({ profileText, explanations, continueTarget }) => {
  const [activeIndex, setActiveIndex] = useState(0)
  const [copyState, setCopyState] = useState("Copy profile")
  const active = explanations[activeIndex]
  const lines = profileText.split("\n")

  const selectStep = (nextIndex) => {
    const bounded = Math.max(0, Math.min(explanations.length - 1, nextIndex))
    setActiveIndex(bounded)
  }

  const moveNext = () => {
    if (activeIndex === explanations.length - 1) {
      document.getElementById(continueTarget)?.focus()
      document.getElementById(continueTarget)?.scrollIntoView({ behavior: "smooth", block: "start" })
      return
    }
    selectStep(activeIndex + 1)
  }

  const copyProfile = async () => {
    try {
      await navigator.clipboard.writeText(profileText)
      setCopyState("Copied")
    } catch {
      setCopyState("Copy unavailable")
    }
    window.setTimeout(() => setCopyState("Copy profile"), 1600)
  }

  const handleKeys = (event) => {
    if (event.key === "ArrowLeft") {
      event.preventDefault()
      selectStep(activeIndex - 1)
    }
    if (event.key === "ArrowRight") {
      event.preventDefault()
      moveNext()
    }
  }

  return (
    <section
      aria-label="Generated profile explorer"
      onKeyDown={handleKeys}
      className="my-8 overflow-hidden rounded-md border border-zinc-200 bg-zinc-50 dark:border-zinc-700 dark:bg-zinc-900"
    >
      <div className="border-b border-zinc-200 px-5 py-3 text-sm font-semibold text-zinc-700 dark:border-zinc-700 dark:text-zinc-200">
        Your first profile, explained
      </div>

      <div className="grid lg:grid-cols-[minmax(220px,0.72fr)_minmax(300px,1fr)_minmax(300px,1fr)]">
        <div className="border-b border-zinc-200 p-5 dark:border-zinc-700 lg:border-b-0 lg:border-r">
          <p className="m-0 text-xs font-semibold uppercase text-emerald-700 dark:text-emerald-400">Local checkpoint</p>
          <h3 className="mb-2 mt-3 text-base font-semibold text-zinc-950 dark:text-white">Create the profile</h3>
          <pre className="overflow-x-auto rounded bg-zinc-950 p-3 text-xs leading-5 text-zinc-100"><code>llmwiki profile init issue-tracker --entity issues</code></pre>
          <p className="mt-4 text-sm text-zinc-700 dark:text-zinc-300">Writes:</p>
          <ul className="mt-1 text-sm text-zinc-700 dark:text-zinc-300">
            <li><code>.llmwiki/profile.json</code></li>
            <li><code>wiki/issues/</code></li>
          </ul>
          <p className="mt-4 text-sm text-zinc-600 dark:text-zinc-400">The command refuses to replace an existing profile or reinterpret existing wiki content.</p>
        </div>

        <div className="min-w-0 border-b border-zinc-200 dark:border-zinc-700 lg:border-b-0 lg:border-r">
          <div className="flex min-h-12 items-center justify-between border-b border-zinc-200 px-4 dark:border-zinc-700">
            <span className="text-sm font-semibold text-zinc-800 dark:text-zinc-100">.llmwiki/profile.json</span>
            <button type="button" onClick={copyProfile} className="min-h-11 px-2 text-sm font-semibold text-indigo-700 hover:underline focus:outline-none focus:ring-2 focus:ring-indigo-500 dark:text-indigo-300">
              {copyState}
            </button>
          </div>
          <pre className="m-0 max-h-[34rem] overflow-auto bg-zinc-950 py-4 text-xs leading-6 text-zinc-300" aria-label="Complete generated profile">
            <code>
              {lines.map((line, index) => {
                const lineNumber = index + 1
                const highlighted = active.lines.includes(lineNumber)
                return (
                  <span key={lineNumber} className={`block border-l-4 px-3 ${highlighted ? "border-emerald-400 bg-emerald-950/70 font-semibold text-white" : "border-transparent"}`}>
                    <span aria-hidden="true" className="mr-4 inline-block w-5 select-none text-right text-zinc-500">{lineNumber}</span>
                    {line || " "}
                  </span>
                )
              })}
            </code>
          </pre>
        </div>

        <div className="flex min-h-[24rem] min-w-0 flex-col bg-white p-5 dark:bg-zinc-950">
          <div aria-live="polite" aria-atomic="true">
            <p className="m-0 text-xs font-semibold uppercase text-emerald-700 dark:text-emerald-400">Step {activeIndex + 1} of {explanations.length}</p>
            <h3 className="mb-1 mt-3 text-lg font-semibold text-zinc-950 dark:text-white">{active.title}</h3>
            <p className="m-0 text-sm text-zinc-500 dark:text-zinc-400"><code>{active.key}</code></p>
            <p className="mt-5 text-base leading-7 text-zinc-800 dark:text-zinc-200">{active.description}</p>
            <h4 className="mb-1 mt-5 text-sm font-semibold text-zinc-950 dark:text-white">Why it matters</h4>
            <p className="m-0 text-sm leading-6 text-zinc-700 dark:text-zinc-300">{active.importance}</p>
          </div>

          <div className="mt-auto pt-8">
            <div className="mb-4 flex gap-2" aria-hidden="true">
              {explanations.map((item, index) => (
                <span key={item.title} className={`h-2 w-8 rounded-sm ${index === activeIndex ? "bg-emerald-600 dark:bg-emerald-400" : "bg-zinc-200 dark:bg-zinc-700"}`} />
              ))}
            </div>
            <div className="grid grid-cols-2 gap-3">
              <button type="button" disabled={activeIndex === 0} onClick={() => selectStep(activeIndex - 1)} className="min-h-11 rounded border border-zinc-300 px-3 text-sm font-semibold text-zinc-800 disabled:cursor-not-allowed disabled:opacity-40 focus:outline-none focus:ring-2 focus:ring-indigo-500 dark:border-zinc-600 dark:text-zinc-100">
                Previous
              </button>
              <button type="button" onClick={moveNext} className="min-h-11 rounded bg-indigo-700 px-3 text-sm font-semibold text-white focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:ring-offset-2 dark:bg-indigo-500">
                {activeIndex === explanations.length - 1 ? "Continue: Add an issue" : "Next"}
              </button>
            </div>
          </div>
        </div>
      </div>

      <div className="hidden print:block">
        {explanations.map((item, index) => <p key={item.title}><strong>{index + 1}. {item.title}:</strong> {item.description} {item.importance}</p>)}
      </div>
    </section>
  )
}
