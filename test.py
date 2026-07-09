n=int(input())
m=2*n
for i in range(1,n):
    if i==1:
        print((n-1)*". "+".")
    else:    
        print((i-1)*" "+((n-(i-1))-1)*". "+".")


print((n-1)*" "+".")



for i in range(1,n):
  
        print(((n-1)-i)*" "+(i)*". "+".")