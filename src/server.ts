import express from 'express'
import cors from 'cors'
import dotenv from 'dotenv'
import morgan from 'morgan'
import { z } from 'zod'
import { PrismaClient, Prisma } from '@prisma/client'
import { phone as parsePhone } from 'phone';

dotenv.config()

const app = express()
app.use(cors({ origin: true }))
app.use(express.json({ limit: '1mb' }))
app.use(morgan('dev'))

const PORT = process.env.PORT ? Number(process.env.PORT) : 4000

const prisma = new PrismaClient()

// Prisma uses DATABASE_URL internally; keep runtime check lenient for dev.
// If DATABASE_URL is missing, Prisma will throw a connection error on first query.


const RsvpSchema = z.object({
  salutation: z.enum(['Mr', 'Mrs', 'Ms']),
  name: z.string().min(2).max(120),
  phone: z.string().min(10).max(16),
})

function accessCodeFromSequence(n: number) {
  return String(n).padStart(4, '0')
}

app.post('/api/rsvp', async (req, res) => {
  try {
    const parsed = RsvpSchema.safeParse(req.body)
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.flatten() })
    }

    const { salutation, name, phone } = parsed.data
    const salutationClean = salutation.replace('.', '') as 'Mr' | 'Mrs' | 'Ms'

    const phoneCleanObj = validateGlobalPhoneNumber(phone)

    if (!phoneCleanObj.isValid) {
      return res.status(400).json({ error: phoneCleanObj.error })
    }

    const phoneClean = { phoneNumber: phoneCleanObj.formattedNumber }

    const result = await prisma.$transaction(async (tx) => {

      // 1) Prevent duplicates: check existing by phone.

      const existing = await tx.rsvp.findUnique({ where: { phone: phoneClean.phoneNumber } })

      if (existing) {
        return {
          accessCode: existing.access_code,
          rsvp: {
            id: existing.id,
            salutation: existing.salutation,
            name: existing.name,
            phone: existing.phone,
            accessCode: existing.access_code,
            createdAt: existing.created_at,
          },
          duplicate: true,
        }
      }

      // 2) Generate next serial access code: fetch max (by created_at order) and increment.
      // If concurrent inserts race, the unique constraint on access_code will trigger
      // and we fall back to the existing row by phone.
      const last = await tx.rsvp.findFirst({
        select: { access_code: true },
        orderBy: { created_at: 'desc' },
      })

      let nextNumber = 1
      if (last?.access_code) {
        const parsedInt = Number.parseInt(last.access_code, 10)
        if (Number.isFinite(parsedInt)) nextNumber = parsedInt + 1
      }

      const accessCode = accessCodeFromSequence(nextNumber)

      try {
        const created = await tx.rsvp.create({
          data: {
            salutation: salutationClean,
            name,
            phone: phoneClean.phoneNumber,
            access_code: accessCode,
          },
        })

        return {
          accessCode,
          rsvp: {
            id: created.id,
            salutation: created.salutation,
            name: created.name,
            phone: created.phone,
            accessCode: created.access_code,
            createdAt: created.created_at,
          },
          duplicate: false,
        }
      } catch (e) {
        const recheck = await tx.rsvp.findUnique({ where: { phone: phoneClean.phoneNumber } })
        if (recheck) {
          return {
            accessCode: recheck.access_code,
            rsvp: {
              id: recheck.id,
              salutation: recheck.salutation,
              name: recheck.name,
              phone: recheck.phone,
              accessCode: recheck.access_code,
              createdAt: recheck.created_at,
            },
            duplicate: true,
          }
        }
        throw e
      }
    })

    return res.json(result)
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error'
    return res.status(500).json({ error: message })
  }
})

app.listen(PORT, () => {
  console.log(`Wedding RSVP backend listening on :${PORT}`)
})

function validateGlobalPhoneNumber(inputNumber:string): { isValid: boolean; formattedNumber?: string; error?: string } {
  // Strip spaces, dashes, and parentheses to clean it up first
  const cleanInput = inputNumber.trim();

  let validationResult;

  // If it starts with '+' or an international exit code like '00', parse globally
  if (cleanInput.startsWith('+') || cleanInput.startsWith('00')) {
    validationResult = parsePhone(cleanInput); // No country parameter = checks worldwide
  } else {
    // If no international sign is provided, fallback to Nigeria (NGA)
    validationResult = parsePhone(cleanInput, { country: 'NGA' });
  }

  if (!validationResult.isValid) {
    return { isValid: false, error: "Invalid phone number format." };
  }

  return {
    isValid: true,
    // This will always be saved in standard E.164 format (+234..., +1..., +44...)
    formattedNumber: validationResult.phoneNumber
  };
}