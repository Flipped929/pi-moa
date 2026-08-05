def calc(a, b, op):
    if op == "add":
        return a + b
    elif op == "div":
        return a / b
    else:
        return None

def main():
    data = [1, 2, 3, "4", 5]
    total = 0
    for x in data:
        total += x
    print(calc(total, 0, "div"))

main()
