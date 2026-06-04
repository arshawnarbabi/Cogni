import { createClient, createServiceClient } from '@/lib/supabase/server'
import { initWiki } from '@/lib/wiki'
import { runProfiler } from '@/lib/agents/profiler'
import { requireOwnedProfessor } from '@/lib/authz'
import { isUserSuspended, consumeAiQuota } from '@/lib/rate-limit'
import { isValidTimeZone } from '@/lib/time'
import { serverError } from '@/lib/api-error'
import { NextResponse } from 'next/server'

type CourseInput = {
  tempIndex: number
  name: string
  professorName: string
  existingProfessorId: string | null
}

type SyllabusInput = {
  courseTemp: number
  storagePath: string
  fileName: string
}

function inferFileType(filename: string): string {
  const ext = filename.split('.').pop()?.toLowerCase() ?? ''
  if (ext === 'pdf') return 'pdf'
  if (ext === 'md') return 'md'
  return 'txt'
}

export async function POST(request: Request) {
  const { displayName, sessionLength, courses, syllabuses, timezone } = await request.json() as {
    displayName: string
    sessionLength: number
    courses: CourseInput[]
    syllabuses: SyllabusInput[]
    timezone?: string
  }

  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()

  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  if (await isUserSuspended(user.id)) {
    return NextResponse.json({ error: 'Account suspended.' }, { status: 403 })
  }

  const service = createServiceClient()

  const safeName = (typeof displayName === 'string' ? displayName.trim() : '') || 'Student'
  const safeTimezone = isValidTimeZone(timezone) ? timezone : 'UTC'

  const { error: userError } = await service.from('users').upsert(
    {
      user_id: user.id,
      display_name: safeName,
      session_length_preference: sessionLength,
      timezone: safeTimezone,
    },
    { onConflict: 'user_id' }
  )

  if (userError) {
    return serverError('onboarding.complete.userUpsert', userError)
  }

  const courseIdMap: Record<number, string> = {}
  const courseNameMap: Record<number, string> = {}

  for (const course of courses) {
    let professorId = course.existingProfessorId

    if (professorId) {
      const ownedProfessor = await requireOwnedProfessor(user.id, professorId)
      if (!ownedProfessor) {
        return NextResponse.json({ error: 'Professor not found' }, { status: 404 })
      }
    }

    if (!professorId) {
      const trimmedProfName = course.professorName.trim()
      // Upsert by (user_id, name): race-safe find-or-create (was select-then-insert,
      // a TOCTOU that duplicated on concurrent/retried onboarding submits).
      const { data: prof, error: profError } = await service
        .from('professors')
        .upsert({ user_id: user.id, name: trimmedProfName }, { onConflict: 'user_id,name' })
        .select('professor_id')
        .single()

      if (profError) {
        return serverError('onboarding.complete.professorUpsert', profError)
      }
      professorId = prof.professor_id
    }

    const trimmedCourseName = course.name.trim()
    let courseId: string
    {
      // Upsert by (user_id, name): race-safe find-or-create for the course.
      const { data: courseRow, error: courseError } = await service
        .from('courses')
        .upsert({ user_id: user.id, professor_id: professorId, name: trimmedCourseName }, { onConflict: 'user_id,name' })
        .select('course_id')
        .single()

      if (courseError) {
        return serverError('onboarding.complete.courseUpsert', courseError)
      }
      courseId = courseRow.course_id
    }

    courseIdMap[course.tempIndex] = courseId
    courseNameMap[course.tempIndex] = trimmedCourseName
  }

  // Insert syllabuses and collect IDs for profiling
  const syllabusJobs: { materialId: string; courseId: string; courseName: string; fileName: string }[] = []

  for (const syl of syllabuses) {
    const courseId = courseIdMap[syl.courseTemp]
    if (!courseId) continue
    if (!syl.storagePath.startsWith(`${user.id}/`)) {
      console.error('[onboarding] rejected syllabus path outside user prefix', syl.storagePath)
      continue
    }

    const fileType = inferFileType(syl.fileName)

    const { data: material, error: materialError } = await service
      .from('materials')
      .insert({
        user_id: user.id,
        course_id: courseId,
        filename: syl.fileName,
        storage_path: syl.storagePath,
        tier: 1,
        file_type: fileType,
        processing_status: 'processed', // already uploaded, skip inbox pipeline
      })
      .select('material_id')
      .single()

    if (materialError) {
      console.error('[onboarding] material insert failed', { file: syl.fileName, error: materialError })
    }

    if (material) {
      syllabusJobs.push({
        materialId: material.material_id,
        courseId,
        courseName: courseNameMap[syl.courseTemp],
        fileName: syl.fileName,
      })
    }
  }

  // Best-effort: a wiki/storage hiccup must NOT block account creation — the wiki
  // files are recreated lazily on first tutor/profiler use anyway.
  try {
    await initWiki(user.id)
  } catch (e) {
    console.error('[onboarding.complete] initWiki failed (non-fatal)', e)
  }

  // Run profiler for each syllabus (extracts topics + updates wiki).
  // Cap the syllabus-analysis AI work per user/day (abuse + free-tier infra guard,
  // shared 'profiler' quota with course-create). Consume one unit PER syllabus so
  // the charge matches course-create's per-run cost; jobs beyond the cap are
  // skipped and onboarding still succeeds (courses are already created).
  const allowedJobs: typeof syllabusJobs = []
  for (const job of syllabusJobs) {
    if (await consumeAiQuota(user.id, 'profiler')) {
      allowedJobs.push(job)
    } else {
      console.warn(`[onboarding] profiler skipped for ${user.id} (${job.fileName}) — daily AI cap reached`)
    }
  }

  if (allowedJobs.length > 0) {
    // Use allSettled so one failure doesn't prevent the response or other jobs
    const results = await Promise.allSettled(
      allowedJobs.map(job =>
        runProfiler(user.id, job.materialId, job.courseId, job.courseName)
      )
    )
    results.forEach((r, i) => {
      if (r.status === 'rejected') {
        console.error(`[onboarding] profiler job ${i} (${allowedJobs[i].fileName}) rejected`, r.reason)
      }
    })
  }

  return NextResponse.json({ ok: true })
}
