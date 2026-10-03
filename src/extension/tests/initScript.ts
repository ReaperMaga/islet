// Gradle init script that reports test progress live, one JSON line per event, to
// <module>/build/islet/test-events/<task>.jsonl. Islet watches those files to update the Testing
// panel while tests run. The script never fails a build: every step is guarded.

/** First line of the script; also used to recognise our own file before replacing or removing it. */
export const INIT_SCRIPT_MARKER = '// Islet test progress reporter';
export const INIT_SCRIPT_NAME = 'islet-test-events.gradle';

export const INIT_SCRIPT = `${INIT_SCRIPT_MARKER} (https://github.com/ReaperMaga/islet).
// Writes test start/finish events to build/islet/test-events/<task>.jsonl so VS Code can show
// live progress. Safe to delete; Islet recreates it only when "islet.gradleTests.trackAllRuns" is on.
import groovy.json.JsonOutput

class IsletTestEvents {
    static synchronized void write(File file, Map event) {
        try {
            file << (JsonOutput.toJson(event) + '\\n')
        } catch (Throwable ignored) {
        }
    }

    static String trace(Throwable t) {
        def sw = new StringWriter()
        t.printStackTrace(new PrintWriter(sw))
        return sw.toString()
    }
}

def isletCacheRequested = false
try {
    isletCacheRequested = gradle.startParameter.configurationCacheRequested
} catch (Throwable ignored) {
}

if (!isletCacheRequested) {
    gradle.allprojects { p ->
        try {
            p.tasks.withType(Test).configureEach { Test t ->
                try {
                    def extra = t.extensions.extraProperties
                    if (extra.has('isletTestEvents')) return
                    extra.set('isletTestEvents', true)
                    def out = new File(p.layout.buildDirectory.get().asFile, "islet/test-events/\${t.name}.jsonl")
                    t.doFirst {
                        try {
                            out.parentFile.mkdirs()
                            out.text = ''
                        } catch (Throwable ignored) {
                        }
                    }
                    t.addTestListener(new TestListener() {
                        void beforeSuite(TestDescriptor d) {}
                        void afterSuite(TestDescriptor d, TestResult r) {}
                        void beforeTest(TestDescriptor d) {
                            IsletTestEvents.write(out, [e: 'start', cls: d.className, name: d.name])
                        }
                        void afterTest(TestDescriptor d, TestResult r) {
                            def failure = r.exceptions ? r.exceptions[0] : null
                            IsletTestEvents.write(out, [
                                e: 'done', cls: d.className, name: d.name,
                                result: r.resultType.toString(), ms: r.endTime - r.startTime,
                                msg: failure ? String.valueOf(failure.message) : null,
                                trace: failure ? IsletTestEvents.trace(failure) : null,
                            ])
                        }
                    })
                } catch (Throwable ignored) {
                }
            }
        } catch (Throwable ignored) {
        }
    }
}
`;
