import express from 'express'
import cors from 'cors'
import dotenv from 'dotenv'
import morgan from 'morgan'
import { z } from 'zod'
import { PrismaClient } from '@prisma/client'
import { phone as parsePhone, PhoneResult } from 'phone'

dotenv.config()

const app = express()
app.use(cors({ origin: true }))
app.use(express.json({ limit: '1mb' }))
app.use(morgan('dev'))

const PORT = process.env.PORT ? Number(process.env.PORT) : 4000
const prisma = new PrismaClient()

const RsvpSchema = z.object({
    salutation: z.enum(['Mr', 'Mrs', 'Ms']),
    name: z.string().min(2).max(120),
    phone: z.string().min(6).max(20),
})

app.post('/api/rsvp', async (req, res) => {
    try {
        const parsed = RsvpSchema.safeParse(req.body)
        if (!parsed.success) {
            return res.status(400).json({ error: parsed.error.flatten() })
        }

        const { salutation, name, phone } = parsed.data
        const salutationClean = salutation.replace('.', '') as 'Mr' | 'Mrs' | 'Ms'

        const phoneCleanObj = validateGlobalPhoneNumber(phone)
        if (!phoneCleanObj.isValid || !phoneCleanObj.formattedNumber) {
            return res.status(400).json({ error: phoneCleanObj.error })
        }

        const basePhoneNumber = phoneCleanObj.formattedNumber
        let accessCode = basePhoneNumber.slice(-5)

        const result = await prisma.$transaction(async (tx) => {
            // 1) Query by full phone number OR by the generated access code
            const existing = await tx.rsvp.findFirst({
                where: {
                    OR: [
                        { phone: basePhoneNumber },
                        { access_code: accessCode }
                    ]
                }
            })

            if (existing) {
                // SCENARIO A: True duplicate. The full phone number matches perfectly.
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

                // SCENARIO B: Collision! A completely different phone number already has this access code.
                // We resolve this safely by appending a single random digit (0-9) to this guest's code.
                // const randomModifier = Math.floor(Math.random() * 10)
                // accessCode = `${accessCode}${randomModifier}`
            }

            // 2) Write the new entry confidently
            const created = await tx.rsvp.create({
                data: {
                    salutation: salutationClean,
                    name,
                    phone: basePhoneNumber,
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

function validateGlobalPhoneNumber(inputNumber: string): { isValid: boolean; formattedNumber?: string; error?: string } {

    let validationResult: PhoneResult, fullDigits = '', countryCode = '';
    // 1. Remove spaces, dashes, brackets, and parentheses completely
    // If they typed "00", normalize it to a single "+" right away
    let cleanInput = inputNumber.trim().replace(/[\s\-\(\)]/g, '');

    cleanInput = cleanInput.replace(/^(\+?234)00/, '$10');

    fullDigits = cleanInput.replace(/\D/g, ''); // Remove all non-digit characters for further processing

    if (cleanInput.startsWith('00')) {
        cleanInput = '+' + cleanInput.slice(2);
    }

    // 2. STRATEGY A: Assume it might be an international number missing a '+'
    // If it doesn't already have a '+', try adding one and see if it's a valid global number
    const globalTestInput = cleanInput.startsWith('+') ? cleanInput : `+${cleanInput}`;
    validationResult = parsePhone(globalTestInput);
    countryCode = validationResult.countryCode;

    if (!countryCode) {
        validationResult = parsePhone(cleanInput, { country: countryCode });

        if (!validationResult.isValid || !validationResult.phoneNumber) {
            fullDigits = cleanInput.replace(/\D/g, '');
        } else {
            fullDigits = validationResult.phoneNumber.replace(/\D/g, '');
        }
    }


    // 5. Demarcation: Slice away the country code from the beginning
    let baseNumber = fullDigits;
    if (fullDigits.startsWith(countryCode)) {
        baseNumber = fullDigits.slice(countryCode.length);
    }

    // 6. Trim any residual local leading zeros (like the inner zero in +234(0)903...)
    if (baseNumber.startsWith('0')) {
        baseNumber = baseNumber.slice(1);
    }

    if (!isOnlyDigits(baseNumber)) {
        return { isValid: false, error: "Invalid phone number format." };
    }

    return {
        isValid: true,
        formattedNumber: baseNumber
    };
}

function isOnlyDigits(str: string): boolean {
    return /^\d+$/.test(str);
}

