// Javascript emulation code for the floating point processor in a DECsystem-10 (PDP-10 KI10) 
// See https://skn.noip.me/pdp10/pdp10.html for more information

// Unfinished :-(

// Handle byte pointer instructions which are in two parts:-
//  i) Byte pointer access and increment - for PXCT this is done in exec space
// ii) The byte operation which is done in the appropriate PXCT space
// The First Part Done flag (FPD) indicates that the byte pointer adjustment has already been
// done in the case of a page failure or instruction restart
function byteInstruction(effectiveAddress, AC, increment, readWrite) {
    "use strict";
    var bytePointer, bytePosition, byteSize, byteAddress, data;
    if (!increment || (CPU.flags & flagFPD)) { // Don't increment pointer if BIS (FPD) set?
        if ((bytePointer = getWordByVirtual(effectiveAddress, accessRead)) >= 0) { // First part of byte instructions ignore PXCT flags
            bytePosition = Math.trunc(bytePointer / BIT5);
            byteSize = Math.trunc(bytePointer / BIT11) % 64;
        }
    } else { // IBP
        if ((bytePointer = getWordByVirtual(effectiveAddress, accessModify)) >= 0) {
            bytePosition = Math.trunc(bytePointer / BIT5);
            byteSize = Math.trunc(bytePointer / BIT11) % 64;
            bytePosition -= byteSize;
            if (bytePosition < 0) {
                bytePosition = (36 - byteSize) & 0x3f;
                bytePointer = combine(left(bytePointer), right(bytePointer) + 1);
            }
            bytePointer = (bytePosition * BIT5) + (bytePointer % BIT5);
            if (modifyWord(bytePointer) < 0) {
                return;
            }
            CPU.flags |= flagFPD; // Set first part done (pointer incremented)
        }
    }
    if (bytePointer >= 0) { // And part 2 the actual byte operation...
        if (readWrite) {
            if ((byteAddress = getEffectiveAddress(bytePointer)) < 0) {
                return byteAddress;
            }
            byteAddress = right(byteAddress);
            byteSize = Math.min(byteSize, 36 - bytePosition);
            if (readWrite < 0) { // LDB loading from word into AC
                data = 0;
                if (byteSize > 0) {
                    if ((data = getWordByVirtual(byteAddress, accessRead | CPU.PXCTflags)) < 0) {
                        return data;
                    }
                    if (bytePosition) {
                        data = Math.trunc(data / power2(bytePosition));
                    }
                    if (byteSize < 36 - bytePosition) {
                        data = data % power2(byteSize);
                    }
                }
                CPU.accumulator[AC] = data;
            } else { // DPB depositing from AC into word
                if (byteSize > 0) {
                    if ((data = getWordByVirtual(byteAddress, accessModify | CPU.PXCTflags)) >= 0) {
                        if (bytePosition == 0) {
                            if (byteSize >= 36) {
                                data = CPU.accumulator[AC];
                            } else {
                                data = (data - (data % power2(byteSize))) + (CPU.accumulator[AC] % power2(byteSize));
                            }
                        } else {
                            if (bytePosition + byteSize >= 36) {
                                data = (CPU.accumulator[AC] % power2(36 - bytePosition)) * power2(bytePosition) + (data % power2(bytePosition));
                            } else {
                                data = (data - (data % power2(bytePosition + byteSize))) + (CPU.accumulator[AC] % power2(byteSize)) * power2(bytePosition) + (data % power2(bytePosition));
                            }
                        }
                        modifyWord(data);
                    }
                }
            }
        }
        clearFlags(flagFPD); // Turn off BIS (FPD)?
    }
}

function readDoubleByVirtual(doubleOperand, virtualAddress) {
    "use strict";
    var result;
    if ((result = readWordByVirtual(virtualAddress)) >= 0) {
        doubleOperand[0] = result;
        if ((result = readWordByVirtual(virtualAddress + 1)) >= 0) {
            doubleOperand[1] = result;
        }
    }
    return result;
}

function writeDoubleByVirtual(virtualAddress, doubleOperand) {
    "use strict";
    var result;
    if ((CPU.flags & flagFPD) || (result = writeWordByVirtual(virtualAddress, doubleOperand[0])) >= 0) {
        CPU.flags |= flagFPD; // Required for diagnostic - we don't really need it
        if ((result = writeWordByVirtual(virtualAddress + 1, doubleOperand[1])) >= 0) {
            CPU.flags &= ~flagFPD;
        }
    }
    return result;
}

function fromFloat(f) { // 36 bit floating point word to Javascript number
    "use strict";
    var result = f;
    if (result) {
        if (result < wordSign) {
            result = (result % BIT8) * power2(Math.trunc(result / BIT8) - 128 - 27);
        } else {
            result = ((result % BIT8) - BIT8) * power2((Math.trunc(result / BIT8) ^ 0o777) - 128 - 27);
        }
    }
    return result;
}

function toFloat(number, round, FSCflag) { // Javascript number to 36 bit floating point word
    "use strict";
    var bits, exponent, sign = 0;
    if (number != 0) {
        if (number < 0) {
            sign = 1;
            number = -number;
        }
        // exponent = 129 + Math.trunc(Math.log2(number)); TOO SLOW :-(
        exponent = 128 + 27;
        if (number >= BIT8) {
            for (bits = 25; bits > 0; bits -= 12) {
                while (number >= BIT9 * (1 << bits)) {
                    number /= (1 << bits);
                    exponent += bits;
                }
            }
        } else {
            if (number < BIT9) {
                for (bits = 25; bits > 0; bits -= 12) {
                    while (number < BIT8 / (1 << bits)) {
                        number *= (1 << bits);
                        exponent -= bits;
                    }
                }
            }
        }
        if (exponent < 0) {
            if (!FSCflag || exponent >= -128) {
                setFlags(flagAOV | flagFOV | flagFXU); // Exponent underflow
            } else {
                setFlags(flagAOV | flagFOV); // FSC Instruction has special case on KI10
            }
            exponent &= 0xff;
        } else {
            if (exponent > 255) {
                if (!FSCflag || exponent <= 383) {
                    setFlags(flagAOV | flagFOV); // Exponent overflow
                } else {
                    setFlags(flagAOV | flagFOV | flagFXU); // FSC Instruction has special case on KI10
                }
                exponent &= 0xff;
            }
        }
        if (!sign) {
            number = exponent * BIT8 + number;
            if (round) {
                number = Math.round(number);
            } else {
                number = Math.trunc(number);
            }
        } else {
            number = wordBase - (exponent * BIT8 + number);
            if (round) {
                number = Math.round(number);
            } else {
                number = Math.floor(number);
            }
        }
    }
    return number;
}

function getFloatExponent(f) { // get 8 bit exponent from floating point word
    "use strict";
    if (f >= wordSign) {
        //f = wordBase - f;
        return Math.trunc(f / BIT8) ^ 0o777;
    }
    return Math.trunc(f / BIT8);
}

function getFloatFraction(f) { // get 27 bits of fraction from floating point word
    "use strict";
    if (f >= wordSign) {
        //f = wordBase - f;
        return BIT8 - (f % BIT8);
    }
    return f % BIT8;
}

function multiplyWords(a, b, base) { // result = a * b
    "use strict";
    var i, j, carry, result = [];
    for (i = 0; i <= a.length + b.length - 1; i++) result[i] = 0;
    for (i = a.length - 1; i >= 0; i--) {
        carry = 0;
        for (j = b.length - 1; j >= 0; j--) {
            carry += a[i] * b[j] + result[1 + i + j];
            result[1 + i + j] = carry % base;
            carry = Math.trunc(carry / base);
        }
        result[i] += carry;
    }
    return result;
}

// Division of a multi-word dividend by divisor return a multi-word result using a selected base
// Integer division doesn't use precision and returns the remainder in dividend. Otherwise the
// floating point precision can be forced to get more decimal places. 
function divideWords(dividend, divisor, base, precision) { // result = dividend / divisor
    "use strict";
    var i, j, divisorPrefix, qhat, carry, quotient = [];
    if (precision) {
        for (i = dividend.length; i < precision + divisor.length - 1; i++) {
            dividend.push(0);
        }
    } else {
        precision = dividend.length + 1 - divisor.length;
    }
    if (divisor.length > 0 && precision > 0) {
        if (divisor.length == 1) { // Single digit division
            divisorPrefix = divisor[0];
            if (divisorPrefix) { // Skip if divide by zero
                carry = 0;
                for (i = 0; i < precision; i++) {
                    carry = carry * base + dividend[i];
                    quotient.push(Math.trunc(carry / divisorPrefix));
                    carry %= divisorPrefix;
                    dividend[i] = 0;
                }
                dividend[dividend.length - 1] = carry;
            }
        } else { // Multi-digit division
            divisorPrefix = divisor[0] * base + divisor[1];
            if (divisorPrefix) { // Skip if divide by zero (leading 0's can't happen for normalised floating point)
                qhat = dividend[0] * base + dividend[1]; // First digit guess
                for (i = 0; i < precision; i++) {
                    if (i > 0) {
                        qhat = (dividend[i - 1] * base + dividend[i]) * base + dividend[i + 1]; // Subsequent digit guess
                    }
                    qhat = Math.trunc(qhat / divisorPrefix);
                    if (qhat > 0) {
                        if (qhat >= base) {
                            qhat = base - 1;
                        }
                        carry = 0; // Multiplication carry forward & subtraction borrow
                        for (j = divisor.length - 1; j >= 0; j--) {
                            carry += dividend[i + j] - qhat * divisor[j];
                            if ((dividend[i + j] = carry % base) < 0) {
                                dividend[i + j] += base;
                                carry -= base;
                            }
                            carry = Math.trunc(carry / base);
                        }
                        if (carry) {
                            if (i == 0 || (dividend[i - 1] += carry)) {
                                qhat--; //Subtract too far, reduce digit and add back divisor
                                carry = 0;
                                for (j = divisor.length - 1; j >= 0; j--) {
                                    carry += dividend[i + j] + divisor[j];
                                    dividend[i + j] = carry % base;
                                    carry = Math.trunc(carry / base);
                                }
                                if (carry && i > 0) {
                                    dividend[i - 1] += carry;
                                }
                            }
                        }
                    }
                    quotient.push(qhat);
                }
            }
        }
    }
    return quotient;
}

// Extract sign from double word and complement if negative (for integer or floating!)
function getSignDoubleInt(doubleWord) {
    "use strict";
    if (doubleWord[1] >= wordSign) { // Strip annoying surplus sign bit in second word
        doubleWord[1] -= wordSign;
    }
    if (doubleWord[0] >= wordSign) {
        DMOVN(doubleWord); // Complement number if negative
        return -1;
    }
    return 1;
}

const
    BASE17 = 0o400000,
    SHIFT29 = 1 << 29,
    SHIFT28 = 1 << 28,
    SHIFT27 = 1 << 27,
    SHIFT26 = 1 << 26,
    SHIFT12 = 1 << 12,
    SHIFT11 = 1 << 11,
    SHIFT10 = 1 << 10,
    SHIFT9 = 1 << 9,
    SHIFT8 = 1 << 8,
    SHIFT7 = 1 << 7,
    SHIFT6 = 1 << 6,
    SHIFT5 = 1 << 5;

// Convert words of double fraction to base 17 to enable multiply and divide
function toLowBase(splitDouble) { // two words of 27 / 35 bits to four words of 17 bits (17, 10/7, 17, 11/6)
    "use strict";
    var hiWord = splitDouble[2],
        loWord = splitDouble[3];
    return [Math.trunc(hiWord / SHIFT10), (hiWord % SHIFT10) * SHIFT7 + Math.trunc(loWord / SHIFT28),
        Math.trunc(loWord / SHIFT11) % BASE17, (loWord % SHIFT11) * SHIFT6
    ];
}

// Convert base 17 back to double fraction - Multiply does at most one shift on a KI10 - so handled here.
function fromLowBaseMultiply(splitDouble, baseWord) { // four words of 17 bits to two words of 27 / 35 bits
    "use strict";
    if (baseWord[0] >= 0o200000) {
        splitDouble[2] = baseWord[0] * SHIFT10 + Math.trunc(baseWord[1] / SHIFT7);
        splitDouble[3] = (baseWord[1] % SHIFT7) * SHIFT28 + baseWord[2] * SHIFT11 + Math.round(baseWord[3] / SHIFT6);
    } else {
        splitDouble[2] = baseWord[0] * SHIFT11 + Math.trunc(baseWord[1] / SHIFT6);
        splitDouble[3] = (baseWord[1] % SHIFT6) * SHIFT29 + baseWord[2] * SHIFT12 + Math.round(baseWord[3] / SHIFT5);
        splitDouble[1]--;
    }
}

// Convert base 17 back to double fraction - Divide also does limited normalization which can cause overflow for non-normalized operands
function fromLowBaseDivide(splitDouble, baseWord) { // FIVE words of 17 bits to two words of 27 / 35 bits
    "use strict";
    if (baseWord[0]) {
        if (baseWord[0] > 1) {
            return -1; // Division not possible (KI10 approach to some non-normalised fractions)
        } else {
            splitDouble[2] = SHIFT26 + baseWord[1] * SHIFT9 + Math.trunc(baseWord[2] / SHIFT8);
            splitDouble[3] = (baseWord[2] % SHIFT8) * SHIFT27 + baseWord[3] * SHIFT10 + Math.trunc(baseWord[4] / SHIFT7);
            splitDouble[1]++;
        }
    } else {
        splitDouble[2] = baseWord[1] * SHIFT10 + Math.trunc(baseWord[2] / SHIFT7);
        splitDouble[3] = (baseWord[2] % SHIFT7) * SHIFT28 + baseWord[3] * SHIFT11 + Math.trunc(baseWord[4] / SHIFT6);
    }
    return 0;
}

// This handles double floating and long operations (add, subtract, multiply & divide)
// long could be handled by the float type except Javascript numbers are 52 bit precision
// while long requires 54. :-( Values are split into a sign, exponent, a high word
// containing 27 bits of fraction, and a low word containing the rest (35 bits plus decimal places)
function doubleOp(acc, op, operation) {
    "use strict";
    switch (operation) {
        case 1: // Subtract
            op[0] *= -1; // Change operand sign and fall into add
        case 0: // Add
            if (acc[1] != op[1]) {
                if (acc[1] < op[1]) {
                    shiftDoubleRight(acc, op[1] - acc[1]);
                } else {
                    shiftDoubleRight(op, acc[1] - op[1]);
                }
            }
            if (op[0] == acc[0]) {
                acc[3] += op[3]; // add fraction
                if (acc[3] >= wordSign) {
                    acc[3] -= wordSign;
                    acc[2]++;
                }
                acc[2] += op[2];
            } else { // subtract fraction
                acc[3] -= op[3];
                if (acc[3] < 0) {
                    acc[3] += wordSign;
                    acc[2]--;
                }
                acc[2] -= op[2];
                if (acc[2] < 0) { // subtract too far - complement answer and swap sign
                    if (acc[3]) {
                        acc[3] = wordSign - acc[3];
                        acc[2]++;
                    }
                    acc[2] = -acc[2];
                    acc[0] = -acc[0];
                }
            }
            //normalizeDouble(acc);
            break;
        case 2: // Multiply
            acc[0] *= op[0]; // Determine sign
            acc[1] += op[1] - 128; // Determine exponent
            fromLowBaseMultiply(acc, multiplyWords(toLowBase(acc), toLowBase(op), BASE17));
            //    normalizeDouble(acc);
            //acc[3] = Math.round(acc[3]);
            break;
        case 3: // Divide
            if (!op[2] && !op[3]) {
                setFlags(flagAOV | flagTR1 | flagFOV | flagDCX); // Divide by zero
                return -1;
            }
            if (fromLowBaseDivide(acc, divideWords(toLowBase(acc), toLowBase(op), BASE17, 5)) < 0) {
                setFlags(flagAOV | flagTR1 | flagFOV | flagDCX); // Division not possible
                return -1;
            }
            acc[0] *= op[0]; // Determine sign
            acc[1] -= op[1] - 128;
			acc[3] = Math.trunc(acc[3]);
            //    normalizeDouble(acc);
            break;
    }
    return 0;
}

// Double floating values are split into a sign, exponent, and two fraction parts - the first contains
// 27 bits while the second contains 35 bits plus a non interger fraction (bit of an overkill actually). 
function splitDouble(hiWord, loWord) {
    "use strict";
    if (loWord >= wordSign) {
        loWord -= wordSign; // Strip useless second sign bit
    }
    if (!hiWord && !loWord) {
        return [1, 0, 0, 0];
    } else {
        if (hiWord < wordSign) {
            return [1, Math.trunc(hiWord / BIT8), hiWord % BIT8, loWord];
        } else {
            if (loWord) {
                return [-1, Math.trunc(hiWord / BIT8) ^ 0o777, BIT8 - (hiWord % BIT8) - 1, wordSign - loWord];
            } else {
                return [-1, Math.trunc(hiWord / BIT8) ^ 0o777, BIT8 - (hiWord % BIT8), 0];
            }
        }
    }
}

// Write a splitDouble into accumulators in PDP10 Double point word format
function writeDouble(AC, splitDouble) {
    "use strict";
    var sign, exponent, hiWord = splitDouble[2], loWord = splitDouble[3];
        sign = splitDouble[0];
        exponent = splitDouble[1];
	if (sign < 0) {
		loWord = Math.ceil(loWord);
	} else {
		loWord = Math.trunc(loWord);
	}
    if (!hiWord && !loWord) {
        CPU.accumulator[AC] = 0;
        CPU.accumulator[nextAC(AC)] = 0;
    } else {
        if (exponent < 0) {
            setFlags(flagTR1 | flagAOV | flagFOV | flagFXU); // Exponent underflow
            exponent &= 0xff;
        } else {
            if (exponent > 255) {
                setFlags(flagTR1 | flagAOV | flagFOV); // Exponent overflow
                exponent &= 0xff;
            }
        }
        if (sign >= 0) {
            CPU.accumulator[AC] = exponent * BIT8 + hiWord;;
            CPU.accumulator[nextAC(AC)] = loWord;
        } else {
            if (loWord) {
                CPU.accumulator[AC] = wordBase - exponent * BIT8 - hiWord - 1;
                //    CPU.accumulator[AC] = (exponent ^ 0o777) * BIT8 + (BIT8 - hiWord - 1);
                CPU.accumulator[nextAC(AC)] = wordSign - loWord;
            } else {
                CPU.accumulator[AC] = wordBase - exponent * BIT8 - hiWord - 1;
                //    CPU.accumulator[AC] = (exponent ^ 0o777) * BIT8 + (BIT8 - hiWord);
                CPU.accumulator[nextAC(AC)] = 0;
            }
        }
        var data = CPU.accumulator[AC];
        if (typeof data == "undefined" || !Number.isInteger(data) || data < 0 || data >= wordBase) {
            console.log("Bad data: " + data + " @" + CPU.PC.toString(8));
            panic(); //debug
        }
        data = CPU.accumulator[nextAC(AC)];
        if (typeof data == "undefined" || !Number.isInteger(data) || data < 0 || data >= wordBase) {
            console.log("Bad data: " + data + " @" + CPU.PC.toString(8));
            panic(); //debug
        }
        checkData(CPU.accumulator[AC]);
        checkData(CPU.accumulator[nextAC(AC)]);
    }
}

// Shift a split double right by adjusting both fraction parts
function shiftDoubleRight(splitDouble, bits) {
    "use strict";
    var factor, hiWord;
    if (bits >= 70) {
        splitDouble[2] = 0;
        splitDouble[3] = 0;
    } else {
        if (bits >= 35) {
            splitDouble[3] = splitDouble[2] / power2(bits - 35);
            splitDouble[2] = 0;
        } else {
            factor = power2(bits);
            hiWord = splitDouble[2] / factor;
            splitDouble[3] = (hiWord % 1) * wordSign + splitDouble[3] / factor;
            splitDouble[2] = Math.trunc(hiWord);
        }
    }
    splitDouble[1] += bits;
}

// Normalize a split double by shifting both fraction parts left or right
function normalizeDouble(splitDouble) {
    "use strict";
    var exponent, hiWord = splitDouble[2],
        loWord = splitDouble[3];
    if (!hiWord && !loWord) {
        splitDouble[1] = 0;
    } else {
        exponent = splitDouble[1];
        if (!hiWord) {
            hiWord = Math.trunc(loWord);
            loWord = (loWord % 1) * wordSign;
            exponent -= 35;
        }
        if (hiWord >= BIT8) {
            do {
                hiWord /= 2;
                loWord /= 2;
                exponent++;
            } while (hiWord >= BIT8);
            loWord = (hiWord % 1) * wordSign + loWord;
            hiWord = Math.trunc(hiWord);
        } else {
            if (hiWord < BIT9) {
                do {
                    hiWord *= 2;
                    loWord *= 2;
                    exponent--;
                } while (hiWord < BIT9);
                hiWord = hiWord + Math.trunc(loWord / wordSign);
                loWord = loWord % wordSign;
            }
        }
        splitDouble[1] = exponent;
        splitDouble[2] = hiWord;
        splitDouble[3] = loWord;
    }
}

// DFAD Double floating Add  		AC,AC+1 = AC,AC+1 + C(E,E+1)
// DFSB Double Floating Subtract   	AC,AC+1 = AC,AC+1 - C(E,E+1)
// DFMP Double Floating Multiply   	AC,AC+1 = AC,AC+1 * C(E,E+1)
// DFDV Double Floating Divide   	AC,AC+1 = AC,AC+1 / C(E,E+1)
function doubleFloatOp(opCode, AC, effectiveAddress) {
    "use strict";
    var acc, doubleOperand = [0, 0];
    if (readDoubleByVirtual(doubleOperand, effectiveAddress) >= 0) {
        acc = splitDouble(CPU.accumulator[AC], CPU.accumulator[nextAC(AC)]);
        if (doubleOp(acc, splitDouble(doubleOperand[0], doubleOperand[1]), opCode & 0x3) >= 0) {
            if (opCode != 0o112) {
                normalizeDouble(acc); // All double float operations normalise
            }
            acc[3] = Math.round(acc[3]); // And all round
            writeDouble(AC, acc);
        }
    }
}

// Long format! :-( Obsolete by the time the KI10 was built but still implemented! :-(
// Two 36 bit words the first of which contains a sign and each with their own exponent and fraction.
// The second exponent is always positive and 27 less than the first exponent. The fraction is 54 bits
// coming from the lower 27 bits in each word.
function writeLong(AC, splitDouble) {
    "use strict";
    var sign, exponent, hiWord = splitDouble[2],
        loWord = Math.trunc(splitDouble[3] / 256); // Use only 27 bits of low word
    if (!hiWord && !loWord) {
        CPU.accumulator[AC] = 0;
        CPU.accumulator[nextAC(AC)] = 0;
    } else {
        sign = splitDouble[0];
        exponent = splitDouble[1];
        if (exponent < 0) {
            setFlags(flagTR1 | flagAOV | flagFOV | flagFXU); // Exponent underflow
            exponent &= 0xff;
        } else {
            if (exponent > 255) {
                setFlags(flagTR1 | flagAOV | flagFOV); // Exponent overflow
                exponent &= 0xff;
            }
        }
        if (exponent == 205) {
            console.log("DEBUG " + sign + "  " + exponent + " (" + exponent.toString(8) + ") " + hiWord.toString(8) + " " + loWord.toString(8) + " [" + (BIT8 - loWord).toString(8) + "] " + splitDouble[3].toString(8));
        }

        //console.log("DEBUG " + sign + "  " + exponent + " (" + exponent.toString(8) + ") " + hiWord.toString(8) + " " + loWord.toString(8) + " [" + (BIT8 - loWord).toString(8) + "] " + splitDouble[3].toString(8));
        if (sign >= 0) {
            CPU.accumulator[AC] = exponent * BIT8 + hiWord;
            if (loWord && (exponent < 101 || exponent >= 128)) {
                CPU.accumulator[nextAC(AC)] = ((exponent - 27) & 0xff) * BIT8 + loWord;
            } else {
                CPU.accumulator[nextAC(AC)] = 0;
            }
        } else {
            if (loWord) {
                hiWord++;
                if (exponent >= 101 && exponent < 128) {
                    loWord = 0;
                }
            }
            CPU.accumulator[AC] = wordBase - (exponent * BIT8) - hiWord;
            if (loWord) {
                CPU.accumulator[nextAC(AC)] = ((exponent - 27) & 0xff) * BIT8 + (BIT8 - loWord);
            } else {
                CPU.accumulator[nextAC(AC)] = 0;
            }
        }
        checkData(CPU.accumulator[AC]);
        checkData(CPU.accumulator[nextAC(AC)]);
    }
}

// Long Real Format: First word as for single precision - second word also contain the complement of the sign and exponent!
// FADL Floating Add Long       C(AC,AC+1) <- C(AC) + C(E) Long format result
// FSBL Floating Subtract Long  C(AC,AC+1) <- C(AC) - C(E) !! Long format result
// FMPL Floating Multiply Long  C(AC,AC+1) <- C(AC) * C(E) !! Long format result
// FDVL Floating Divide Long    C(AC) <- C(AC,AC+1) / C(E), C(AC+1) <- R !! Note different use of operands
function longOp(opCode, AC, effectiveAddress) {
    "use strict";
    var src, acc, op, rem, remainder, quotient;
    if ((src = readWordByVirtual(effectiveAddress)) >= 0) {
        if (opCode != 0o171) {
            acc = splitDouble(CPU.accumulator[AC], 0);
            if (doubleOp(acc, splitDouble(src, 0), (opCode >>> 3) & 0x3) >= 0) {
                if (1 || opCode != 0o161) {
                    normalizeDouble(acc); // FMPL does not normalize
                }
                writeLong(AC, acc);
            }
        } else { // FDVL is the only instruction that actually reads a long operand (2 * 27 bit fraction) which comes from two accumulators
            //console.log("debug FDVL " + CPU.accumulator[AC].toString(8) + " " + CPU.accumulator[nextAC(AC)].toString(8) + " " + src.toString(8) + " ");
            if (!src) {
                setFlags(flagAOV | flagTR1 | flagFOV | flagDCX); // Divide by zero
                return -1;
            }
            if (!CPU.accumulator[AC]) { // If high word is zero then just generate zeros
                CPU.accumulator[AC] = 0;
                CPU.accumulator[nextAC(AC)] = 0;
            } else {
                op = splitFloat(src);
                acc = splitDouble(CPU.accumulator[AC], CPU.accumulator[nextAC(AC)] % BIT8); // Let splitDouble handle negative operand for us but then we use BASE17...
                remainder = [Math.trunc(acc[2] / (1 << 24)), Math.trunc(acc[2] / (1 << 7)) % BASE17, ((acc[2] % (1 << 7)) * (1 << 10)) + (Math.trunc(acc[3] / BASE17) % (1 << 10)), acc[3] % BASE17];
                quotient = divideWords(remainder, [Math.trunc(op[2] / BASE17), op[2] % BASE17], BASE17, 0);
                if (quotient[1] > 0o10000) {
                    setFlags(flagAOV | flagTR1 | flagFOV | flagDCX); // Divide by too big for KI10
                    return -1;
                }
                rem = [acc[0], acc[1] - 27, remainder[2] * BASE17 + remainder[3]];
                acc[0] *= op[0]; // Determine sign
                acc[1] -= op[1] - 128;
                acc[2] = quotient[1] * BASE17 + quotient[2];
                normalizeFloat(acc);
                CPU.accumulator[AC] = makeFloat(acc, 0);
                if (acc[1] < 0) {
                    CPU.accumulator[nextAC(AC)] = 0;
                } else {
                    CPU.accumulator[nextAC(AC)] = makeFloat(rem, 0);
                }
            }
        }
    }
}

// Floating values are split into a sign, exponent, and a fraction containing 27 bits which 
// may contain decimal places for extra accuracy (although the KI10 uses a 54 bit register for
// this we seem to do ok using a 52 bit precision Javascript number).
function splitFloat(word) {
    "use strict";
    if (!word) {
        return [1, 0, 0];
    } else {
        if (word < wordSign) {
            return [1, Math.trunc(word / BIT8), word % BIT8];
        } else {
            return [-1, Math.trunc(word / BIT8) ^ 0o777, BIT8 - (word % BIT8)];
        }
    }
}

// Assemble a splitFloat into a PDP 10 floating point word
function makeFloat(splitFloat, opCode) {
    "use strict";
    var sign = splitFloat[0],
        exponent = splitFloat[1],
        fraction = splitFloat[2];
    if (!fraction) {
        return 0;
    } else {
        if (sign < 0) { // Negate fraction BEFORE truncation or rounding (div handled elsewhere)
            fraction = BIT8 - fraction;
        }
        if (opCode & 4) { // Rounding
            fraction = Math.round(fraction);
            if (fraction >= BIT8) {
                fraction = Math.trunc(fraction / 2)
                exponent++;
            }
        } else {
            fraction = Math.trunc(fraction);
        }
        if (exponent < 0) {
            setFlags(flagAOV | flagFOV | flagFXU); // Exponent underflow
            exponent &= 0xff;
        } else {
            if (exponent > 255) {
                setFlags(flagAOV | flagFOV); // Exponent overflow
                exponent &= 0xff;
            }
        }
        if (sign >= 0) {
            return exponent * BIT8 + fraction;
        } else {
            return (exponent ^ 0o777) * BIT8 + fraction;
        }
    }
}

// Shift a split float right - note fraction part may be non-integer
function shiftRightFloat(splitFloat, bits) {
    "use strict";
    if (bits > 31) {
        if (bits >= 64 || splitFloat[0] >= 0) {
            splitFloat[2] = 0;
        } else {
            splitFloat[2] = 0.0005;
        }
    } else {
        splitFloat[2] = splitFloat[2] / (1 << bits);
    }
    splitFloat[1] += bits;
}

// Normalize a split float by shifting left or right
function normalizeFloat(splitFloat) {
    "use strict";
    var exponent, fraction = splitFloat[2];
    if (!fraction) {
        splitFloat[1] = 0;
    } else {
        if (fraction >= BIT8) {
            exponent = splitFloat[1];
            do {
                fraction /= 2;
                exponent++;
            } while (fraction >= BIT8);
            splitFloat[1] = exponent;
            splitFloat[2] = fraction;
        } else {
            if (fraction < BIT9) {
                exponent = splitFloat[1];
                do {
                    fraction *= 2;
                    exponent--;
                } while (fraction < BIT9);
                splitFloat[1] = exponent;
                splitFloat[2] = fraction;
            }
        }
    }
}

//            |AD add                     |  to AC
// F floating |SB subtract |R rounded     |I Immediate (E,0) to AC
//            |MP multiply |              |M to memory
//            |DV divide   |              |B to memory and AC
//                         |  no rounding |  to AC
//                                        |L Long mode
//                                        |M to memory
// 0    C(AC) <- C(AC) . C(E)
// 1 I  C(AC) <- C(AC) . 0,,E
// 2 M  C(E)  <- C(AC) . C(E)
// 3 B  C(AC) <- C(AC) . C(E); C(E) <- C(AC)
// 5 L  C(AC) <- C(AC) . C(E); C(AC+1) <- loResult
function floatOp(opCode, AC, effectiveAddress) {
    "use strict";
    var src, acc = [0, 0, 0],
        op = [0, 0, 0];
    if ((src = readWordForOperand(opCode, AC, effectiveAddress)) >= 0) {
        if ((opCode & 7) == 5) { // Immediate special case
            src *= halfBase; // Convert immediate 0,E to E,0
        }
        acc = splitFloat(CPU.accumulator[AC]);
        op = splitFloat(src);
        switch ((opCode >>> 3) & 0x3) {
            case 1: // Subtract
                op[0] *= -1; // Change operand sign and fall into add
            case 0: // Add
                if (acc[1] != op[1]) {
                    if (acc[1] < op[1]) {
                        shiftRightFloat(acc, op[1] - acc[1]);
                    } else {
                        shiftRightFloat(op, acc[1] - op[1]);
                    }
                }
                if (op[0] != acc[0]) {
                    acc[2] -= op[2];
                    if (acc[2] < 0) {
                        acc[2] = -acc[2];
                        acc[0] = -acc[0];
                    }
                } else {
                    acc[2] += op[2];
                }
                normalizeFloat(acc);
                break;
            case 2: // Multiply
                acc[0] *= op[0];
                acc[1] += op[1] - 128;
                acc[2] = acc[2] * op[2];
                if (acc[2] >= 0o400000000000000000) {
                    acc[2] = acc[2] / BIT8;
                } else {
                    acc[2] = acc[2] / BIT9;
                    acc[1]--;
                    if (acc[2] < BIT9) {
                        normalizeFloat(acc);
                    }
                }
                break;
            case 3: // Divide
                if (!op[2]) {
                    setFlags(flagAOV | flagTR1 | flagFOV | flagDCX); // Divide by zero
                    return;
                } else {
                    if (acc[2] >= 2 * op[2]) { // KI10 can't divide if op fraction too small :-(
                        setFlags(flagTR1 | flagAOV | flagFOV | flagDCX);
                        return;
                    } else {
                        acc[0] *= op[0];
                        acc[1] -= op[1] - 128;
                        acc[2] = acc[2] / op[2];
                        if (acc[2] >= 0o1) {
                            acc[2] = acc[2] * BIT9;
                            acc[1]++;
                        } else {
                            acc[2] = acc[2] * BIT8;
                        }
                        if (opCode & 4) { // KI10 has limited precision division so round here before normalization
                            acc[2] = Math.round(acc[2]);
                        } else {
                            acc[2] = Math.trunc(acc[2]);
                        }
                        if (acc[2] < BIT9) {
                            normalizeFloat(acc);
                        }
                    }
                }
        }
        writeResult(makeFloat(acc, opCode));
    }
}

// Double Floating Negate - Long (software) format
function DFN(AC, effectiveAddress) {
    "use strict";
    var operand, result, carry;
    if ((operand = readWordByVirtual(effectiveAddress)) >= 0) { // get C(E)
        result = operand % BIT8;
        carry = 0;
        if (result) {
            result = (operand - result) + (BIT8 - result);
            carry = 1;
        }
        if (writeWordByVirtual(effectiveAddress, result) >= 0) {
            CPU.accumulator[AC] = wordBase - CPU.accumulator[AC] - carry;
        }
    }
}

// Unnormalized Floating Add 
function UFA(AC, effectiveAddress) {
    "use strict";
    var src, acc, op;
    if ((src = readWordByVirtual(effectiveAddress)) >= 0) {
        acc = splitFloat(CPU.accumulator[AC]);
        op = splitFloat(src);
        if (acc[1] != op[1]) {
            if (acc[1] < op[1]) {
                shiftRightFloat(acc, op[1] - acc[1]);
            } else {
                shiftRightFloat(op, acc[1] - op[1]);
            }
        }
        if (op[0] == acc[0]) { // If same sign just add 
            acc[2] += op[2];
        } else {
            if (op[2] > acc[2]) { // If subracting larger operand change sign
                acc[2] = op[2] - acc[2];
                acc[0] *= -1;
            } else { // Simple subtraction then
                acc[2] -= op[2];
            }
        }
        if (acc[2] >= BIT8) { // May require one shift right
            shiftRightFloat(acc, 1);
        }
        CPU.accumulator[nextAC(AC)] = makeFloat(acc, 0);
    }
}

// Despite floating point references in the manual this is an integer complement
function DMOVN(doubleWord) {
    "use strict";
    if (doubleWord[1] >= wordSign) { // Throw away second sign bit
        doubleWord[1] -= wordSign;
    }
    if (doubleWord[1]) {
        doubleWord[1] = wordSign - doubleWord[1];
        doubleWord[0] = wordBase - doubleWord[0] - 1;
    } else {
        if (doubleWord[0]) {
            doubleWord[0] = wordBase - doubleWord[0];
        }
    }
    return 1;
}

floatOpName = [
    "FAD", "FADL", "FADM", "FADB", "FADR", "FADRI", "FADRM", "FADRB",
    "FSB", "FSBL", "FSBM", "FSBB", "FSBR", "FSBRI", "FSBRM", "FSBRB",
    "FMP", "FMPL", "FMPM", "FMPB", "FMPR", "FMPRI", "FMPRM", "FMPRB",
    "FDV", "FDVL", "FDVM", "FDVB", "FDVR", "FDVRI", "FDVRM", "FDVRB"
];

// opCode 100-177: Floating point and Byte manipulation
function fpp10(instruction, AC, effectiveAddress, opCode) {
    "use strict";
    var src, dst, doubleOperand = [];
    switch (opCode) {
        case 0o100: // UJEN - unimplemented on KI10
        case 0o101: // (101)  - unimplemented on KI10
        case 0o102: // GFAD - unimplemented on KI10
        case 0o103: // GFSB - unimplemented on KI10
        case 0o104: // JSYS - unimplemented on KI10
        case 0o105: // ADJSP - unimplemented on KI10
        case 0o106: // GFMP - unimplemented on KI10
        case 0o107: // GFDV - unimplemented on KI10
            LOG_INSTRUCTION(instruction, AC, effectiveAddress, "illegal");
            UUO(opCode, AC, effectiveAddress, 0);
            break;
        case 0o110: // DFAD Double floating Add  		AC,AC+1 = AC,AC+1 + C(E,E+1)
        case 0o111: // DFSB Double Floating Subtract   	AC,AC+1 = AC,AC+1 - C(E,E+1)
        case 0o112: // DFMP Double Floating Multiply   	AC,AC+1 = AC,AC+1 * C(E,E+1)
        case 0o113: // DFDV Double Floating Divide   	AC,AC+1 = AC,AC+1 / C(E,E+1)
            LOG_INSTRUCTION(instruction, AC, effectiveAddress, ["DFAD", "DFSB", "DFMP", "DFDV"][opCode & 3]);
            doubleFloatOp(opCode, AC, effectiveAddress);
            break;
        case 0o114: // DADD Double Integer Add  	AC,AC+1 = AC,AC+1 + C(E,E+1) - unimplemented on KI10
        case 0o115: // DSUB Double Integer Subtract AC,AC+1 = AC,AC+1 - C(E,E+1) - unimplemented on KI10
        case 0o116: // DMUL Double Integer Multiply AC,AC+1 = AC,AC+1 * C(E,E+1) - unimplemented on KI10
        case 0o117: // DDIV Double Integer Divide   AC,AC+1 = AC,AC+1 / C(E,E+1) - unimplemented on KI10
            LOG_INSTRUCTION(instruction, AC, effectiveAddress, "illegal");
            UUO(opCode, AC, effectiveAddress, 0);
            break;
        case 0o120: // DMOVE        C(AC,AC+1) <- C(E,E+1)
            LOG_INSTRUCTION(instruction, AC, effectiveAddress, "DMOVE");
            if (readDoubleByVirtual(doubleOperand, effectiveAddress) >= 0) {
                CPU.accumulator[AC] = doubleOperand[0];
                CPU.accumulator[nextAC(AC)] = doubleOperand[1];
            }
            break;
        case 0o121: // DMOVN        DMOVN   C(AC,AC+1) <- -C(E,E+1)
            LOG_INSTRUCTION(instruction, AC, effectiveAddress, "DMOVN");
            if (readDoubleByVirtual(doubleOperand, effectiveAddress) >= 0) {
                if (DMOVN(doubleOperand) >= 0) {
                    CPU.accumulator[AC] = doubleOperand[0];
                    CPU.accumulator[nextAC(AC)] = doubleOperand[1];
                }
            }
            break;
        case 0o122: // FIX Convert float to fixed  C(AC) = integer of C(E)
            LOG_INSTRUCTION(instruction, AC, effectiveAddress, "FIX");
            if ((src = readWordByVirtual(effectiveAddress)) >= 0) { // get C(E)
                src = Math.trunc(fromFloat(src));
                if (src <= -wordSign || src >= wordSign) {
                    setFlags(flagAOV | flagTR1); // Set AOV, TR1
                } else {
                    if (src >= 0) {
                        CPU.accumulator[AC] = src;
                    } else {
                        CPU.accumulator[AC] = wordBase + src;
                    }
                }
            }
            break;
        case 0o123: // EXTEND - unimplemented on KI10
            LOG_INSTRUCTION(instruction, AC, effectiveAddress, "EXTEND");
            UUO(opCode, AC, effectiveAddress, 0);
            break;
        case 0o124: // DMOVEM   C(E,E+1) <- C(AC,AC+1)
            LOG_INSTRUCTION(instruction, AC, effectiveAddress, "DMOVEM");
            doubleOperand[0] = CPU.accumulator[AC];
            doubleOperand[1] = CPU.accumulator[nextAC(AC)];
            writeDoubleByVirtual(effectiveAddress, doubleOperand); // DMOVEM and DMOVN do one
            break;
        case 0o125: // DMOVNM   DMOVNM  C(E,E+1) <- -C(AC,AC+1)
            LOG_INSTRUCTION(instruction, AC, effectiveAddress, "DMOVNM");
            doubleOperand[0] = CPU.accumulator[AC];
            doubleOperand[1] = CPU.accumulator[nextAC(AC)];
            if (DMOVN(doubleOperand) >= 0) {
                writeDoubleByVirtual(effectiveAddress, doubleOperand);
            }
            break;
        case 0o126: // FIXR
            LOG_INSTRUCTION(instruction, AC, effectiveAddress, "FIXR");
            if ((src = readWordByVirtual(effectiveAddress)) >= 0) { // get C(E)
                src = Math.round(fromFloat(src));
                if (src <= -wordSign || src >= wordSign) {
                    setFlags(flagAOV | flagTR1); // Set AOV, TR1
                } else {
                    if (src >= 0) {
                        CPU.accumulator[AC] = src;
                    } else {
                        CPU.accumulator[AC] = wordBase + src;
                    }
                }
            }
            break;
        case 0o127: // FLTR Convert float to fixed and round
            LOG_INSTRUCTION(instruction, AC, effectiveAddress, "FLTR");
            if ((src = readWordByVirtual(effectiveAddress)) >= 0) { // get C(E)
                CPU.accumulator[AC] = toFloat(fromInteger(src), 1, 0);
            }
            break;
        case 0o130: // UFA Unnormalized floating Add C(A+1) = C(A) + C(E) unnormalized????
            LOG_INSTRUCTION(instruction, AC, effectiveAddress, "UFA");
            UFA(AC, effectiveAddress);
            break;
        case 0o131: // DFN Double floating negate
            LOG_INSTRUCTION(instruction, AC, effectiveAddress, "DFN");
            DFN(AC, effectiveAddress);
            break;
        case 0o132: // FSC Floating scale
            LOG_INSTRUCTION(instruction, AC, effectiveAddress, "FSC");
            dst = fromFloat(CPU.accumulator[AC]);
            if (dst) {
                src = effectiveAddress;
                if (src < halfSign) {
                    dst *= power2(src % 256);
                } else {
                    src = (halfBase - src) % 256;
                    if (!src) src = 256;
                    dst /= power2(src);
                }
            }
            CPU.accumulator[AC] = toFloat(dst, 0, 1);
            break;
        case 0o133: // IBP  Increment byte pointer
            LOG_INSTRUCTION(instruction, AC, effectiveAddress, "IBP");
            byteInstruction(effectiveAddress, AC, 1, 0);
            break;
        case 0o134: // ILDB Increment pointer and Load byte into AC
            LOG_INSTRUCTION(instruction, AC, effectiveAddress, "ILDB");
            byteInstruction(effectiveAddress, AC, 1, -1);
            break;
        case 0o135: // LDB  Load byte into AC
            LOG_INSTRUCTION(instruction, AC, effectiveAddress, "LDB");
            byteInstruction(effectiveAddress, AC, 0, -1);
            break;
        case 0o136: // IDPB Increment pointer and Deposit Byte
            LOG_INSTRUCTION(instruction, AC, effectiveAddress, "IDPB");
            byteInstruction(effectiveAddress, AC, 1, 1);
            break;
        case 0o137: // DPB  Deposit Byte
            LOG_INSTRUCTION(instruction, AC, effectiveAddress, "DPB");
            byteInstruction(effectiveAddress, AC, 0, 1);
            break;
        case 0o141: // FADL Floating Add Long   	C(AC,AC+1) <- C(AC) + C(E) !! Long format result
        case 0o151: // FSBL Floating Subtract Long  C(AC,AC+1) <- C(AC) - C(E) !! Long format result
        case 0o161: // FMPL Floating Multiply Long  C(AC,AC+1) <- C(AC) * C(E) !! Long format result
        case 0o171: // FDVL Floating Divide Long  	C(AC) <- C(AC,AC+1) / C(E), C(AC+1) <- R !! Note different use of operands
            LOG_INSTRUCTION(instruction, AC, effectiveAddress, ["FADL", "FSBL", "FMPL", "FDVL"][(opCode >>> 3) & 3]);
            longOp(opCode, AC, effectiveAddress);
            break;
        case 0o140: // FAD Floating Add             C(AC) <- C(AC) + C(E)
        case 0o142: // FADM Floating Add to Memory  C(E)  <- C(AC) + C(E)
        case 0o143: // FADB Floating Add to Both    C(AC) <- C(AC) + C(E);  C(E) <- C(AC)
        case 0o144: // FADR Floating Add and Round            C(AC) <- C(AC) + C(E)
        case 0o145: // FADRI Floating Add and Round Immediate C(AC) <- C(AC) + E,0
        case 0o146: // FADRM Floating Add and Round to Memory C(E)  <- C(E) + C(E)
        case 0o147: // FADRB Floating Add and Round to Both   C(AC) <- C(AC) + C(E);  C(E) <- C(AC)
        case 0o150: // FSB Floating Subtract                  C(AC) <- C(AC) - C(E)
        case 0o152: // FSBM Floating Subtract to Memory C(E)  <- C(AC) - C(E)
        case 0o153: // FSBB Floating Subtract to Both   C(AC) <- C(AC) - C(E);  C(E) <- C(AC)
        case 0o154: // FSBR Floating Subtract and Round             C(AC) <- C(AC) - C(E)
        case 0o155: // FSBRI Floating Subtract and Round Immediate  C(AC) <- C(AC) + E,0
        case 0o156: // FSBRM Floating Subtract and Round to Memory  C(E)  <- C(E) - C(E)
        case 0o157: // FSBRB Floating Subtract and Round to Both    C(AC) <- C(AC) - C(E);  C(E) <- C(AC)
        case 0o160: // FMP Floating Multiply            C(AC) <- C(AC) * C(E)
        case 0o162: // FMPM Floating Multiply to Memory C(E)  <- C(E) * C(E
        case 0o163: // FMPB Floating Multiply to Both   C(AC) <- C(AC) * C(E);  C(E) <- C(AC)
        case 0o164: // FMPR Floating Multiply and Round             C(AC) <- C(AC) * C(E)
        case 0o165: // FMPRI Floating Multiply and Round Immediate  C(AC) <- C(AC) * E,0
        case 0o166: // FMPRM Floating Multiply and Round to Memory  C(E)  <- C(E) * C(E)
        case 0o167: // FMPRB Floating Multiply and Round to Both    C(AC) <- C(AC) * C(E);  C(E) <- C(AC)
        case 0o170: // FDV Floating Divide              C(AC) <- C(AC) / C(E)
        case 0o172: // FDVM Floating Divide to Memory   C(E)  <- C(E) / C(E)
        case 0o173: // FDVB Floating Divide to Both     C(AC) <- C(AC) / C(E);  C(E) <- C(AC)
        case 0o174: // FDVR Floating Divide and Round           	C(AC) <- C(AC) / C(E)
        case 0o175: // FDVRI Floating Divide and Round Immediate    C(E)  <- C(AC) / L(E)
        case 0o176: // FDVRM Floating Divide and Round to Memory    C(E)  <- C(E) / C(E)
        case 0o177: // FDVRB Floating Divide and Round to Both  	C(AC) <- C(AC) / C(E);  C(E) <- C(AC)
            LOG_INSTRUCTION(instruction, AC, effectiveAddress, floatOpName[(opCode >>> 3) - 0o140]);
            floatOp(opCode, AC, effectiveAddress);
            break;
    }
}